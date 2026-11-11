import type { Types } from "mongoose";
import { CallSession, ConcurrencyGate, VoiceWorker } from "../../../models";
import { limitsFor } from "./sessionManager";
import { WORKER_STALE_MS, recommendWorkers } from "./workers";

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

/** Live concurrency picture for ONE business. Nothing here can include another tenant's calls or workers. */
export async function concurrencyMetrics(businessId: Types.ObjectId, now = new Date()) {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const fresh = new Date(now.getTime() - WORKER_STALE_MS());
  const [lim, gate, live, recent, workers] = await Promise.all([
    limitsFor(businessId),
    ConcurrencyGate.findOne({ businessId }),
    CallSession.aggregate([{ $match: { businessId, lifecycle: { $in: ["incoming", "initializing", "active", "completing"] } } }, { $group: { _id: "$lifecycle", n: { $sum: 1 } } }]),
    CallSession.find({ businessId, startedAt: { $gte: since } }).select("lifecycle failureCause terminationReason timings durationSeconds latency").limit(20_000),
    VoiceWorker.find({ businessId }).select("workerId capacity active status lastHeartbeatAt cpuPct memMb"),
  ]);

  const byState = Object.fromEntries(live.map((l) => [l._id as string, l.n as number]));
  const active = gate?.active ?? 0;
  const overflowed = recent.filter((s) => s.failureCause?.startsWith("overflow:"));
  const failed = recent.filter((s) => s.lifecycle === "failed" && !s.failureCause?.startsWith("overflow:"));
  const causes: Record<string, number> = {};
  for (const s of failed) causes[s.failureCause || s.terminationReason || "unknown"] = (causes[s.failureCause || s.terminationReason || "unknown"] ?? 0) + 1;
  const setup = recent.map((s) => s.timings?.setupMs).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  const turns = recent.reduce((t, s) => t + (s.latency?.turns ?? 0), 0);
  const totalMs = recent.reduce((t, s) => t + (s.latency?.totalMs ?? 0), 0);
  const done = recent.filter((s) => s.lifecycle === "completed" && (s.durationSeconds ?? 0) > 0);

  const live_ = workers.filter((w) => w.status === "up" && w.lastHeartbeatAt >= fresh);
  const capacity = live_.reduce((t, w) => t + w.capacity, 0);
  const used = live_.reduce((t, w) => t + w.active, 0);
  const cpu = live_.filter((w) => w.cpuPct != null);
  const avgCpu = cpu.length ? cpu.reduce((t, w) => t + (w.cpuPct ?? 0), 0) / cpu.length : undefined;
  const perWorker = live_.length ? Math.round(capacity / live_.length) : 0;

  return {
    limits: { effective: lim.limit, business: lim.businessLimit, carrier: lim.carrierLimit, overflowPolicy: lim.policy, transferConfigured: !!lim.transferTo },
    calls: { active, peak: gate?.peak ?? 0, utilizationPct: lim.limit ? Math.round((active / lim.limit) * 100) : 0, byState },
    last24h: {
      sessions: recent.length,
      completed: recent.filter((s) => s.lifecycle === "completed").length,
      failed: failed.length,
      failureCauses: causes,
      overflowed: overflowed.length,
      setupMs: { avg: setup.length ? Math.round(setup.reduce((a, b) => a + b, 0) / setup.length) : null, p95: pct(setup, 95), max: setup.length ? setup[setup.length - 1] : null, samples: setup.length },
      avgAgentTurnMs: turns ? Math.round(totalMs / turns) : null,
      avgDurationSeconds: done.length ? Math.round(done.reduce((t, s) => t + (s.durationSeconds ?? 0), 0) / done.length) : null,
    },
    workers: {
      poolRegistered: workers.length > 0,
      live: live_.length,
      down: workers.filter((w) => w.status === "down" || (w.status === "up" && w.lastHeartbeatAt < fresh)).length,
      capacity, used, available: Math.max(0, capacity - used),
      avgCpuPct: avgCpu == null ? null : Math.round(avgCpu),
      avgMemMb: live_.filter((w) => w.memMb != null).length ? Math.round(live_.reduce((t, w) => t + (w.memMb ?? 0), 0) / live_.filter((w) => w.memMb != null).length) : null,
      recommended: live_.length ? recommendWorkers({ activeCalls: Math.max(active, 1), perWorkerCapacity: perWorker || 1, liveWorkers: live_.length, avgCpuPct: avgCpu }) : null,
    },
  };
}
