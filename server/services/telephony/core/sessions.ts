import type { Types } from "mongoose";
import { logger } from "../../../config/logger";
import { Business, BusinessPhoneNumber, Call, CallRecoveryTask, CallSession, FollowUp, SipTrunk, TelephonyConnection } from "../../../models";
import type { ConnectionKind } from "../../../models";
import { normalizePhone } from "../../../utils/phone";
import { finalizeCall, createCallSession } from "../../calls/callService";
import { notify } from "../../notifications/notificationService";
import { publish } from "../../realtime";
import { recordHealth } from "./health";
import { resolveBusinessByDid } from "./numbers";
import type { TelephonyEvent } from "./types";

/** Reasons that mean the call was cut off by OUR side or the platform (not by the caller hanging up). */
const INFRASTRUCTURE_FAILURES = new Set(["provider_error", "media_failure", "worker_unavailable", "gateway_shutdown", "trunk_failure", "backend_error", "timeout"]);
const TERMINAL = new Set(["completed", "failed", "no_answer", "busy", "canceled"]);

export interface RouteDecision {
  action: "answer" | "reject";
  reason?: "unknown_number" | "capacity" | "wrong_account";
  callId?: string;
  businessId?: string;
}

/**
 * A call arrives at the gateway for a dialled number. Decide which business answers, enforce capacity, and create
 * the Call + CallSession exactly once (the gateway may retry: the same providerCallId returns the same session).
 */
export async function routeIncoming(connectionBusinessId: Types.ObjectId, kind: ConnectionKind, e: Extract<TelephonyEvent, { type: "incoming" }>): Promise<RouteDecision> {
  const mapped = await resolveBusinessByDid(e.to);
  if (!mapped) return { action: "reject", reason: "unknown_number" };
  // Tenant guard: a connection may only deliver calls for numbers that belong to its own business.
  if (String(mapped.business._id) !== String(connectionBusinessId)) return { action: "reject", reason: "wrong_account" };

  const existing = await CallSession.findOne({ connectionKind: kind, providerCallId: e.providerCallId });
  if (existing?.callId) return { action: "answer", callId: String(existing.callId), businessId: String(mapped.business._id) };

  const limit = await concurrencyLimit(mapped.business._id, mapped.numberId);
  const active = await CallSession.countDocuments({ businessId: mapped.business._id, status: { $in: ["ringing", "answered", "in_progress"] } });
  if (active >= limit) {
    await captureEmergencyCallback({ businessId: mapped.business._id, callerNumber: normalizePhone(e.from), reason: "capacity", key: `cap:${kind}:${e.providerCallId}` });
    return { action: "reject", reason: "capacity" };
  }

  const call = await createCallSession({
    businessId: mapped.business._id, provider: "sip", providerCallId: e.providerCallId, callerNumber: normalizePhone(e.from) || e.from,
    businessNumber: normalizePhone(e.to), routingReason: "direct_ai", handledBy: "ai", status: "ai_answered",
  });
  await CallSession.updateOne(
    { connectionKind: kind, providerCallId: e.providerCallId },
    { $setOnInsert: { businessId: mapped.business._id, callId: call._id, connectionKind: kind, direction: "inbound", providerCallId: e.providerCallId, fromNumber: normalizePhone(e.from), toNumber: normalizePhone(e.to), status: "ringing", startedAt: new Date() } },
    { upsert: true },
  );
  return { action: "answer", callId: String(call._id), businessId: String(mapped.business._id) };
}

async function concurrencyLimit(businessId: Types.ObjectId, numberId?: Types.ObjectId): Promise<number> {
  const n = numberId ? await BusinessPhoneNumber.findById(numberId).select("trunkId") : null;
  const trunk = n?.trunkId ? await SipTrunk.findById(n.trunkId).select("maxConcurrentCalls") : await SipTrunk.findOne({ businessId }).select("maxConcurrentCalls");
  return trunk?.maxConcurrentCalls ?? 10;
}

/** Applies one gateway event to its session. Safe to deliver twice. */
export async function applyEvent(businessId: Types.ObjectId, kind: ConnectionKind, e: TelephonyEvent): Promise<void> {
  if (e.type === "heartbeat") {
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
  for (const s of stale) {
    const claimed = await CallSession.findOneAndUpdate({ _id: s._id, endedAt: null }, { $set: { status: "failed", endedAt: now, terminationReason: "timeout", durationSeconds: Math.round((now.getTime() - s.startedAt.getTime()) / 1000) } });
    if (!claimed) continue;
    if (s.callId) {
      const call = await Call.findById(s.callId).select("endedAt");
      if (call && !call.endedAt) await finalizeCall(s.callId, { forceStatus: "failed" });
    }
    await captureEmergencyCallback({ businessId: s.businessId, callerNumber: s.fromNumber ?? "", reason: "timeout", sessionId: s._id, callId: s.callId ?? undefined, key: `${s._id}:timeout` });
  }
  return stale.length;
}
