import type { Types } from "mongoose";
import { VoiceWorker } from "../../../models";

/** A worker that has not sent a heartbeat for this long is treated as gone. */
export const WORKER_STALE_MS = () => Number(process.env.VOICE_WORKER_STALE_MS) || 30_000;

export interface WorkerHeartbeat { workerId: string; capacity: number; active?: number; draining?: boolean; cpuPct?: number; memMb?: number }

/** Workers announce themselves and their load. Capacity is whatever the operator measured; we never assume one. */
export async function recordWorkerHeartbeat(businessId: Types.ObjectId, h: WorkerHeartbeat) {
  const $set: Record<string, unknown> = { capacity: h.capacity, lastHeartbeatAt: new Date(), status: h.draining ? "draining" : "up" };
  if (h.cpuPct !== undefined) $set.cpuPct = h.cpuPct;
  if (h.memMb !== undefined) $set.memMb = h.memMb;
  await VoiceWorker.updateOne({ businessId, workerId: h.workerId }, { $set, $setOnInsert: { active: 0 } }, { upsert: true });
}

/**
 * Claims one slot on the least-loaded live worker. The capacity check and the increment are ONE atomic update, so
 * simultaneous calls can never overbook a worker. Returns null when no worker has room.
 */
export async function claimWorker(businessId: Types.ObjectId, now = new Date()): Promise<string | null> {
  const fresh = new Date(now.getTime() - WORKER_STALE_MS());
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidates = await VoiceWorker.find({ businessId, status: "up", lastHeartbeatAt: { $gte: fresh }, $expr: { $lt: ["$active", "$capacity"] } }).sort({ active: 1 }).limit(3).select("workerId");
    for (const c of candidates) {
      const won = await VoiceWorker.findOneAndUpdate({ _id: c._id, businessId, status: "up", $expr: { $lt: ["$active", "$capacity"] } }, { $inc: { active: 1 } }, { returnDocument: "after" });
      if (won) return won.workerId;
    }
    if (!candidates.length) return null;
  }
  return null;
}

export async function releaseWorker(businessId: Types.ObjectId, workerId: string | undefined | null) {
  if (!workerId) return;
  await VoiceWorker.updateOne({ businessId, workerId, active: { $gt: 0 } }, { $inc: { active: -1 } });
}

/** Marks workers that stopped reporting as down. Returns their ids so their sessions can be failed over. */
export async function markDeadWorkers(now = new Date()): Promise<{ businessId: Types.ObjectId; workerId: string }[]> {
  const stale = await VoiceWorker.find({ status: { $ne: "down" }, lastHeartbeatAt: { $lt: new Date(now.getTime() - WORKER_STALE_MS()) } }).select("workerId businessId");
  if (!stale.length) return [];
  await VoiceWorker.updateMany({ _id: { $in: stale.map((w) => w._id) } }, { $set: { status: "down", active: 0 } });
  return stale.map((w) => ({ businessId: w.businessId, workerId: w.workerId }));
}

/**
 * Autoscaling recommendation. Scaling the processes themselves is the operator's/orchestrator's job (this app cannot
 * start servers); this says how many workers are needed to keep `headroomPct` free, and raises it when measured CPU is hot.
 */
export function recommendWorkers(p: { activeCalls: number; perWorkerCapacity: number; liveWorkers: number; headroomPct?: number; avgCpuPct?: number; min?: number; max?: number }): { desired: number; reason: string } {
  const headroom = p.headroomPct ?? 25;
  const need = Math.ceil((p.activeCalls * (1 + headroom / 100)) / Math.max(1, p.perWorkerCapacity));
  let desired = Math.max(p.min ?? 1, need);
  let reason = `${p.activeCalls} active calls at ${p.perWorkerCapacity} per worker with ${headroom}% headroom`;
  if ((p.avgCpuPct ?? 0) >= 75) { desired = Math.max(desired, p.liveWorkers + 1); reason = `average CPU ${Math.round(p.avgCpuPct!)}% is above 75%`; }
  desired = Math.min(desired, p.max ?? 1000);
  return { desired, reason };
}
