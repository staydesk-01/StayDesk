import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { logger } from "../../../config/logger";
import { Business, BusinessPhoneNumber, CallSession, ConcurrencyGate, SipTrunk } from "../../../models";
import type { Lifecycle } from "../../../models";
import { claimWorker, releaseWorker } from "./workers";

/** Opaque, unguessable. Used for room names, worker dispatch and logs instead of phone numbers. */
export const newSessionKey = () => `ses_${randomBytes(12).toString("base64url")}`;
export const roomFor = (sessionKey: string) => `call-${sessionKey}`;

const NEXT: Record<Lifecycle, Lifecycle[]> = {
  incoming: ["initializing", "completing", "failed"],
  initializing: ["active", "completing", "failed"],
  active: ["completing", "failed"],
  completing: ["completed", "failed"],
  completed: [],
  failed: [],
};
export const canTransition = (from: Lifecycle, to: Lifecycle) => NEXT[from].includes(to);

export type OverflowPolicy = "callback" | "transfer" | "voicemail";
export interface Limits { limit: number; businessLimit: number; carrierLimit: number | null; policy: OverflowPolicy; transferTo: string }

/** The effective limit is the LOWER of the business setting and the carrier trunk's own channel limit. */
export async function limitsFor(businessId: Types.ObjectId, numberId?: Types.ObjectId, opts: { carrier?: boolean } = {}): Promise<Limits> {
  const [biz, num] = await Promise.all([Business.findById(businessId).select("concurrency escalationPhone"), numberId ? BusinessPhoneNumber.findById(numberId).select("trunkId") : null]);
  const trunk = opts.carrier === false ? null : num?.trunkId ? await SipTrunk.findById(num.trunkId).select("maxConcurrentCalls") : await SipTrunk.findOne({ businessId }).select("maxConcurrentCalls");
  const businessLimit = biz?.concurrency?.maxConcurrentCalls ?? 10;
  const carrierLimit = trunk?.maxConcurrentCalls ?? null;
  const policy = (biz?.concurrency?.overflowPolicy as OverflowPolicy | undefined) ?? "callback";
  return { limit: carrierLimit ? Math.min(businessLimit, carrierLimit) : businessLimit, businessLimit, carrierLimit, policy, transferTo: biz?.escalationPhone ?? "" };
}

/** Atomically takes one concurrency slot. Check and increment are one update: 25 simultaneous arrivals cannot exceed the limit. */
export async function acquireSlot(businessId: Types.ObjectId, limit: number): Promise<boolean> {
  await ConcurrencyGate.updateOne({ businessId }, { $setOnInsert: { active: 0, peak: 0, overflowed: 0 } }, { upsert: true }).catch((e) => { if ((e as { code?: number }).code !== 11000) throw e; });
  const gate = await ConcurrencyGate.findOneAndUpdate({ businessId, active: { $lt: limit } }, { $inc: { active: 1 } }, { returnDocument: "after" });
  if (!gate) { await ConcurrencyGate.updateOne({ businessId }, { $inc: { overflowed: 1 } }); return false; }
  if (gate.active > gate.peak) await ConcurrencyGate.updateOne({ businessId, peak: { $lt: gate.active } }, { $set: { peak: gate.active } });
  return true;
}
export const releaseSlot = (businessId: Types.ObjectId) => ConcurrencyGate.updateOne({ businessId, active: { $gt: 0 } }, { $inc: { active: -1 } });

/** Reserves the worker for a session, or reports that the pool is full. */
export async function assignWorker(businessId: Types.ObjectId): Promise<string | null> { return claimWorker(businessId); }

/**
 * Moves a session through its lifecycle. Only legal, forward transitions apply; a duplicate or out-of-order event is a
 * harmless no-op. Returns the updated session, or null if nothing changed.
 */
export async function transition(sessionId: Types.ObjectId, to: Lifecycle, extra: Record<string, unknown> = {}) {
  const from = (Object.keys(NEXT) as Lifecycle[]).filter((f) => canTransition(f, to));
  const stamp: Record<string, Date> = {};
  const now = new Date();
  if (to === "initializing") stamp["timings.initializingAt"] = now;
  if (to === "active") stamp["timings.activeAt"] = now;
  if (to === "completing") stamp["timings.completingAt"] = now;
  return CallSession.findOneAndUpdate({ _id: sessionId, lifecycle: { $in: from } }, { $set: { lifecycle: to, ...stamp, ...extra } }, { returnDocument: "after" });
}

/** Releases the business slot and the worker slot exactly once, however many times it is called. */
export async function releaseResources(sessionId: Types.ObjectId): Promise<boolean> {
  const held = await CallSession.findOneAndUpdate({ _id: sessionId, slotHeld: true }, { $set: { slotHeld: false } });
  if (!held) return false;
  await Promise.all([releaseSlot(held.businessId), releaseWorker(held.businessId, held.workerId)]);
  return true;
}

/** Runs completing → completed|failed, records the cause, and frees resources. Safe to call twice. */
export async function closeSession(sessionId: Types.ObjectId, outcome: { ok: boolean; cause?: string }) {
  const s = await CallSession.findById(sessionId).select("lifecycle timings");
  if (!s || s.lifecycle === "completed" || s.lifecycle === "failed") { await releaseResources(sessionId); return null; }
  if (outcome.ok) {
    await transition(sessionId, "completing");
    return finish(sessionId, "completed", undefined);
  }
  return finish(sessionId, "failed", outcome.cause ?? "unknown");
}
async function finish(sessionId: Types.ObjectId, to: "completed" | "failed", cause?: string) {
  const done = await transition(sessionId, to, cause ? { failureCause: cause } : {});
  await releaseResources(sessionId);
  return done;
}

/** Marks incoming → initializing → (worker assigned). Setup time is recorded when the call becomes active. */
export async function markActive(sessionId: Types.ObjectId) {
  const s = await transition(sessionId, "active");
  if (s) {
    const setupMs = Date.now() - s.startedAt.getTime();
    await CallSession.updateOne({ _id: sessionId }, { $set: { "timings.setupMs": setupMs } });
  }
  return s;
}

/**
 * Self-healing: recompute each gate from the sessions that really hold a slot, so a crash between "take slot" and
 * "release slot" can never leave a business permanently short of capacity.
 */
export async function reconcileGates(): Promise<number> {
  const held = await CallSession.aggregate([{ $match: { slotHeld: true } }, { $group: { _id: "$businessId", n: { $sum: 1 } } }]);
  const counts = new Map(held.map((h) => [String(h._id), h.n as number]));
  const gates = await ConcurrencyGate.find({});
  let fixed = 0;
  for (const g of gates) {
    const want = counts.get(String(g.businessId)) ?? 0;
    if (g.active !== want) { await ConcurrencyGate.updateOne({ _id: g._id }, { $set: { active: want } }); fixed++; }
  }
  if (fixed) logger.warn("Concurrency gates reconciled", { fixed });
  return fixed;
}
