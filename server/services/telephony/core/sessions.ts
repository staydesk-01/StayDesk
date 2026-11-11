import type { Types } from "mongoose";
import { logger } from "../../../config/logger";
import { Business, Call, CallRecoveryTask, CallSession, FollowUp, TelephonyConnection, VoiceWorker } from "../../../models";
import type { ConnectionKind } from "../../../models";
import { normalizePhone } from "../../../utils/phone";
import { finalizeCall, createCallSession } from "../../calls/callService";
import { notify } from "../../notifications/notificationService";
import { publish } from "../../realtime";
import { acquireSlot, assignWorker, closeSession, limitsFor, reconcileGates, markActive, newSessionKey, releaseSlot, roomFor, transition } from "../concurrency/sessionManager";
import type { Limits, OverflowPolicy } from "../concurrency/sessionManager";
import { markDeadWorkers, recordWorkerHeartbeat, releaseWorker } from "../concurrency/workers";
import { recordHealth } from "./health";
import { resolveBusinessByDid } from "./numbers";
import type { TelephonyEvent } from "./types";

/** Reasons that mean the call was cut off by OUR side or the platform (not by the caller hanging up). */
const INFRASTRUCTURE_FAILURES = new Set(["provider_error", "media_failure", "worker_unavailable", "gateway_shutdown", "trunk_failure", "backend_error", "timeout"]);
const TERMINAL = new Set(["completed", "failed", "no_answer", "busy", "canceled"]);

export interface RouteDecision {
  action: "answer" | "reject" | "transfer";
  reason?: "unknown_number" | "capacity" | "wrong_account" | "no_worker_capacity";
  callId?: string;
  businessId?: string;
  /** Opaque session id and the dedicated media room: one room per caller, never shared. */
  sessionKey?: string;
  room?: string;
  workerId?: string;
  /** What the gateway should do with a call we cannot take: play a "we will call you back" message, voicemail, or hand over to this number. */
  overflow?: OverflowPolicy;
  transferTo?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A call arrives at the gateway for a dialled number. Decide which business answers, enforce the per-business and
 * carrier limits and worker capacity, and create the Call + CallSession exactly once. The unique (kind, providerCallId)
 * row is the claim: of any number of simultaneous duplicate deliveries only one proceeds; the rest receive its decision.
 */
export async function routeIncoming(connectionBusinessId: Types.ObjectId, kind: ConnectionKind, e: Extract<TelephonyEvent, { type: "incoming" }>): Promise<RouteDecision> {
  const mapped = await resolveBusinessByDid(e.to);
  if (!mapped) return { action: "reject", reason: "unknown_number" };
  // Tenant guard: a connection may only deliver calls for numbers that belong to its own business.
  if (String(mapped.business._id) !== String(connectionBusinessId)) return { action: "reject", reason: "wrong_account" };
  const businessId = mapped.business._id as Types.ObjectId;
  const from = normalizePhone(e.from) || e.from;

  const sessionKey = newSessionKey();
  const claim = await CallSession.updateOne(
    { connectionKind: kind, providerCallId: e.providerCallId },
    { $setOnInsert: { businessId, connectionKind: kind, direction: "inbound", providerCallId: e.providerCallId, fromNumber: normalizePhone(e.from), toNumber: normalizePhone(e.to), status: "ringing", lifecycle: "incoming", startedAt: new Date(), sessionKey, roomName: roomFor(sessionKey) } },
    { upsert: true },
  );
  if (!claim.upsertedCount) return existingDecision(kind, e.providerCallId, businessId);
  const session = await CallSession.findOne({ connectionKind: kind, providerCallId: e.providerCallId });
  if (!session) throw new Error("session vanished after claim");

  const lim = await limitsFor(businessId, mapped.numberId);
  let slot = false;
  let worker: string | null = null;
  try {
    slot = await acquireSlot(businessId, lim.limit);
    if (!slot) return await overflow(session._id, businessId, from, lim, "capacity", `cap:${kind}:${e.providerCallId}`);
    if (await VoiceWorker.countDocuments({ businessId })) {
      // A worker pool is registered: a call needs a free worker. (No pool registered = the gateway runs the AI itself.)
      worker = await assignWorker(businessId);
      if (!worker) {
        await releaseSlot(businessId); slot = false;
        return await overflow(session._id, businessId, from, lim, "no_worker_capacity", `wrk:${kind}:${e.providerCallId}`);
      }
    }
    const call = await createCallSession({
      businessId, provider: "sip", providerCallId: e.providerCallId, callerNumber: from,
      businessNumber: normalizePhone(e.to), routingReason: "direct_ai", handledBy: "ai", status: "ai_answered",
    });
    await CallSession.updateOne({ _id: session._id }, { $set: { callId: call._id, slotHeld: true, ...(worker ? { workerId: worker } : {}) } });
    await transition(session._id, "initializing");
    return { action: "answer", callId: String(call._id), businessId: String(businessId), sessionKey, room: roomFor(sessionKey), ...(worker ? { workerId: worker } : {}) };
  } catch (err) {
    // Setup failed part-way: give back everything we took and leave an honest record. The error still surfaces so the gateway can fail over.
    if (slot && !(await CallSession.exists({ _id: session._id, slotHeld: true }))) await releaseSlot(businessId);
    await releaseWorker(businessId, worker);
    await closeSession(session._id, { ok: false, cause: "setup_error" }).catch(() => undefined);
    logger.error("Call setup failed", { sessionKey, message: (err as Error).message });
    throw err;
  }
}

/** A duplicate delivery gets the first delivery's decision (waiting briefly if that one is still being set up). */
async function existingDecision(kind: ConnectionKind, providerCallId: string, businessId: Types.ObjectId): Promise<RouteDecision> {
  for (let i = 0; i < 60; i++) {
    const s = await CallSession.findOne({ connectionKind: kind, providerCallId });
    if (s?.callId && s.lifecycle !== "failed") return { action: "answer", callId: String(s.callId), businessId: String(businessId), sessionKey: s.sessionKey ?? undefined, room: s.roomName ?? undefined, ...(s.workerId ? { workerId: s.workerId } : {}) };
    if (s?.lifecycle === "failed") {
      const reason = s.terminationReason === "no_worker_capacity" ? "no_worker_capacity" : "capacity";
      const lim = await limitsFor(businessId);
      return { action: lim.policy === "transfer" && lim.transferTo ? "transfer" : "reject", reason, sessionKey: s.sessionKey ?? undefined, overflow: lim.policy, ...(lim.policy === "transfer" && lim.transferTo ? { transferTo: lim.transferTo } : {}) };
    }
    await sleep(50);
  }
  throw new Error("duplicate call is still being set up");
}

/** Beyond capacity: never drop silently. Record why, queue a callback, and tell the gateway how to treat the caller. */
async function overflow(sessionId: Types.ObjectId, businessId: Types.ObjectId, from: string, lim: Limits, reason: "capacity" | "no_worker_capacity", key: string): Promise<RouteDecision> {
  await CallSession.updateOne({ _id: sessionId }, { $set: { status: "failed", lifecycle: "failed", endedAt: new Date(), terminationReason: reason, failureCause: `overflow:${lim.policy}`, durationSeconds: 0 } });
  const transfer = lim.policy === "transfer" && !!lim.transferTo;
  // A transfer hands the caller to a person; callback and voicemail both leave a task so someone follows up.
  if (!transfer) await captureEmergencyCallback({ businessId, callerNumber: from, reason, key });
  const session = await CallSession.findById(sessionId).select("sessionKey");
  return { action: transfer ? "transfer" : "reject", reason, sessionKey: session?.sessionKey ?? undefined, overflow: lim.policy, ...(transfer ? { transferTo: lim.transferTo } : {}) };
}

/** Applies one gateway event to its session. Safe to deliver twice. */
export async function applyEvent(businessId: Types.ObjectId, kind: ConnectionKind, e: TelephonyEvent): Promise<void> {
  if (e.type === "heartbeat") {
    if (e.worker) await recordWorkerHeartbeat(businessId, e.worker);
    await TelephonyConnection.updateOne({ businessId, kind }, { $set: { lastOkAt: new Date(), lastCheckedAt: new Date(), status: "connected", statusReason: "Gateway heartbeat received", consecutiveFailures: 0 } });
    await recordHealth(kind, "heartbeat", `active calls: ${e.activeCalls ?? "unknown"}`, { businessId });
    return;
  }
  if (e.type === "incoming") return void (await routeIncoming(businessId, kind, e));

  const session = await CallSession.findOne({ businessId, connectionKind: kind, providerCallId: e.providerCallId });
  if (!session) return; // unknown or another tenant's call: ignored, never created from an event alone

  if (e.type === "dtmf") {
    // Keypad digits can be payment or ID numbers: a sequence is never stored, only that something was keyed.
    const stored = e.digits.length === 1 && /^[0-9*#]$/.test(e.digits) ? e.digits : "•".repeat(Math.min(e.digits.length, 16));
    await CallSession.updateOne({ _id: session._id }, { $push: { dtmf: { $each: [stored], $slice: -64 } } });
    return;
  }
  if (e.type === "quality") {
    await CallSession.updateOne({ _id: session._id }, { $set: { quality: { jitterMs: e.jitterMs, packetLossPct: e.packetLossPct, rttMs: e.rttMs, mos: e.mos } } });
    return;
  }
  if (e.type === "latency") {
    await CallSession.updateOne({ _id: session._id }, { $inc: { "latency.turns": 1, "latency.totalMs": e.turnMs }, $max: { "latency.maxMs": e.turnMs } });
    return;
  }

  // status
  if (session.endedAt && TERMINAL.has(session.status)) return; // already closed: duplicate delivery
  const patch: Record<string, unknown> = { status: e.status };
  if (e.status === "answered" && !session.answeredAt) patch.answeredAt = new Date();
  if (TERMINAL.has(e.status)) {
    patch.endedAt = new Date();
    patch.terminationReason = e.reason ?? e.status;
    patch.durationSeconds = e.durationSeconds ?? Math.max(0, Math.round((Date.now() - session.startedAt.getTime()) / 1000));
  }
  await CallSession.updateOne({ _id: session._id }, { $set: patch });
  if (e.status === "answered" || e.status === "in_progress") await markActive(session._id);
  if (TERMINAL.has(e.status)) {
    // The caller hanging up, not answering or a busy line are not system failures; anything else is, with its cause kept.
    const ok = e.status === "completed" || e.status === "canceled" || e.status === "busy" || e.status === "no_answer";
    await closeSession(session._id, { ok, cause: e.reason ?? e.status });
  }
  publish(businessId, "call.updated", { id: String(session.callId ?? session._id) });

  if (TERMINAL.has(e.status) && session.callId) {
    const infra = !!e.reason && INFRASTRUCTURE_FAILURES.has(e.reason);
    const call = await Call.findById(session.callId).select("endedAt");
    if (call && !call.endedAt) await finalizeCall(session.callId, { durationSeconds: e.durationSeconds, forceStatus: e.status === "completed" ? undefined : e.status === "canceled" ? "abandoned" : "failed" });
    if (infra) await captureEmergencyCallback({ businessId, callerNumber: session.fromNumber ?? "", reason: e.reason!, sessionId: session._id, callId: session.callId, key: `${session._id}:${e.reason}` });
  }
}

/**
 * Nobody should lose a caller because our infrastructure failed. Creates ONE recovery task and ONE high-priority
 * follow-up per incident (the key makes retries harmless) and tells the owner.
 */
export async function captureEmergencyCallback(p: { businessId: Types.ObjectId; callerNumber: string; reason: string; key: string; callId?: Types.ObjectId; sessionId?: Types.ObjectId }) {
  try {
    await CallRecoveryTask.create({ businessId: p.businessId, callId: p.callId, sessionId: p.sessionId, callerNumber: p.callerNumber, reason: p.reason, key: p.key });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return; // already captured
    throw e;
  }
  const business = await Business.findById(p.businessId).select("isDemo");
  await FollowUp.create({
    businessId: p.businessId, callId: p.callId, phone: p.callerNumber, priority: "high", dueAt: new Date(Date.now() + 3600_000),
    reason: `A call was lost because of a phone-system problem (${p.reason.replace(/_/g, " ")}). The caller was not helped. Please call them back.`,
    isDemo: business?.isDemo ?? false,
  }).catch((e) => logger.error("Could not create recovery follow-up", { message: (e as Error).message }));
  await notify({ businessId: p.businessId, type: "unresolved_request", title: "A call was lost to a phone-system problem", body: `Caller ${p.callerNumber || "unknown"} needs a callback (${p.reason.replace(/_/g, " ")}).`, link: "/follow-ups", callId: p.callId }).catch(() => undefined);
}

/**
 * Resource cleanup: a session that never reported an end (gateway crashed, event lost) must not count against the
 * concurrency limit forever or leave a call open. Closes it as failed, finalises the call, and queues ONE callback
 * because we cannot know the caller was helped.
 */
export async function reapStaleSessions(now = new Date(), maxAgeMs = Number(process.env.TELEPHONY_MAX_SESSION_MS) || 4 * 3600_000): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const stale = await CallSession.find({ status: { $in: ["ringing", "answered", "in_progress"] }, startedAt: { $lt: cutoff } }).limit(200);
  let closed = 0;
  for (const s of stale) closed += (await failSession(s._id, "timeout", now)) ? 1 : 0;
  // Workers that stopped reporting: fail the calls they held (their audio is gone) and queue callbacks, then repair counters.
  const dead = await markDeadWorkers(now);
  if (dead.length) {
    const orphaned = await CallSession.find({ workerId: { $in: dead.map((d) => d.workerId) }, slotHeld: true, endedAt: null }).limit(500);
    for (const s of orphaned) closed += (await failSession(s._id, "worker_unavailable", now)) ? 1 : 0;
  }
  await reconcileGates();
  return closed;
}

/** Ends a session that cannot continue: one terminal state, one finalised call, one callback, resources freed. */
async function failSession(sessionId: Types.ObjectId, reason: string, now: Date): Promise<boolean> {
  const s = await CallSession.findOne({ _id: sessionId });
  if (!s) return false;
  const claimed = await CallSession.findOneAndUpdate({ _id: s._id, endedAt: null }, { $set: { status: "failed", endedAt: now, terminationReason: reason, durationSeconds: Math.round((now.getTime() - s.startedAt.getTime()) / 1000) } });
  if (!claimed) return false;
  await closeSession(s._id, { ok: false, cause: reason });
  if (s.callId) {
    const call = await Call.findById(s.callId).select("endedAt");
    if (call && !call.endedAt) await finalizeCall(s.callId, { forceStatus: "failed" });
  }
  await captureEmergencyCallback({ businessId: s.businessId, callerNumber: s.fromNumber ?? "", reason, sessionId: s._id, callId: s.callId ?? undefined, key: `${s._id}:${reason}` });
  return true;
}
