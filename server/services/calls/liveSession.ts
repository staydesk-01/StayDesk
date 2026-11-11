import type { Types } from "mongoose";
import { logger } from "../../config/logger";
import { Business, BusinessKnowledge, Call, CallSession } from "../../models";
import type { BusinessDoc, CallDoc, SessionStage } from "../../models";
import { acquireSlot, closeSession, limitsFor, markActive, newSessionKey, transition } from "../telephony/concurrency/sessionManager";
import { captureEmergencyCallback } from "../telephony/core/sessions";
import type { CallInstruction } from "../telephony";
import { publish } from "../realtime";

/**
 * Call Session Manager for the Twilio webhook path. Every inbound call gets ONE isolated CallSession row, keyed by the
 * Twilio CallSid (unique), with its own opaque session id, stage, timings and concurrency slot. Webhook retries and
 * duplicate events find the same row, so nothing is created or counted twice. Conversation state itself lives on the
 * Call (per call id), never in a shared in-memory object, so concurrent calls cannot see each other's data.
 */

/** Creates the session when a call arrives (or returns the existing one). Never throws into the call path. */
export async function openSession(call: CallDoc, to: string): Promise<void> {
  try {
    const key = newSessionKey();
    const [biz, kb] = await Promise.all([Business.findById(call.businessId).select("updatedAt"), BusinessKnowledge.findOne({ businessId: call.businessId }).select("updatedAt")]);
    await CallSession.updateOne(
      { connectionKind: "twilio", providerCallId: call.providerCallId },
      { $setOnInsert: { businessId: call.businessId, callId: call._id, direction: call.direction ?? "inbound", fromNumber: call.callerNumber, toNumber: to, status: "ringing", lifecycle: "incoming", stage: "incoming", stageAt: new Date(), startedAt: new Date(), sessionKey: key, configRef: `business@${biz?.updatedAt?.getTime() ?? 0}/knowledge@${kb?.updatedAt?.getTime() ?? 0}` } },
      { upsert: true },
    );
    publish(call.businessId, "call.updated", { id: String(call._id) });
  } catch (e) {
    logger.error("Could not open call session", { callId: String(call._id), message: (e as Error).message });
  }
}

/** Best-effort progress marker for the Live Calls view. A failure here must never affect the call. */
export async function setStage(callId: Types.ObjectId | string, stage: SessionStage): Promise<void> {
  try {
    const r = await CallSession.findOneAndUpdate({ callId, connectionKind: "twilio", lifecycle: { $nin: ["completed", "failed"] } }, { $set: { stage, stageAt: new Date() } }, { projection: { businessId: 1 } });
    if (r) publish(r.businessId, "call.updated", { id: String(callId) });
  } catch { /* progress display only */ }
}

const CAPACITY_SAY = "We're receiving a very high number of calls right now. I've noted your number and someone from the team will call you back as soon as possible. Thank you for your patience. Goodbye.";

/**
 * The AI is about to take this call. Takes a concurrency slot atomically; beyond the business's limit the caller is never
 * left hanging: they get the configured fallback and a callback task is created for the team.
 */
export async function admitAi(call: CallDoc, business: BusinessDoc): Promise<{ ok: true } | { ok: false; instruction: CallInstruction }> {
  const filter = { callId: call._id, connectionKind: "twilio" as const };
  let s = await CallSession.findOne(filter);
  if (!s) { await openSession(call, call.businessNumber); s = await CallSession.findOne(filter); }
  if (!s) return { ok: true }; // session store unavailable: do not drop the caller because of bookkeeping
  if (s.admission === "admitted") return { ok: true }; // retry / duplicate event

  // Only one delivery gets to decide; others wait briefly for its answer.
  const claim = await CallSession.findOneAndUpdate({ _id: s._id, admission: { $exists: false } }, { $set: { admission: "pending" } });
  if (!claim) {
    for (let i = 0; i < 40; i++) {
      const cur = await CallSession.findById(s._id);
      if (cur?.admission === "admitted") return { ok: true };
      if (cur?.admission === "overflow") return { ok: false, instruction: await overflowInstruction(call, business, cur.overflowTransferTried) };
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ok: true };
  }

  const lim = await limitsFor(business._id, undefined, { carrier: false });
  if (await acquireSlot(business._id, lim.limit)) {
    await CallSession.updateOne({ _id: s._id }, { $set: { admission: "admitted", slotHeld: true, status: "in_progress" } });
    await transition(s._id, "initializing");
    await setStage(call._id, "initializing");
    return { ok: true };
  }
  await CallSession.updateOne({ _id: s._id }, { $set: { admission: "overflow", failureCause: `overflow:${lim.policy}` } });
  logger.warn("Call refused: at capacity", { sessionKey: s.sessionKey, limit: lim.limit });
  return { ok: false, instruction: await overflowInstruction(call, business, false) };
}

async function overflowInstruction(call: CallDoc, business: BusinessDoc, transferTried: boolean): Promise<CallInstruction> {
  const lim = await limitsFor(business._id, undefined, { carrier: false });
  const number = business.escalationPhone;
  if (lim.policy === "transfer" && number && !transferTried) {
    await CallSession.updateOne({ callId: call._id, connectionKind: "twilio" }, { $set: { overflowTransferTried: true, stage: "transferring", stageAt: new Date() } });
    // A failed overflow transfer comes back through the dial-result hook, which lands here again and falls through to the callback message.
    return { kind: "dial", say: "All of our assistants are busy. I'm connecting you to our team.", number, ringSeconds: 25, actionUrl: `${process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? ""}/api/twilio/dial-result?callId=${call._id}` };
  }
  // "voicemail" needs <Record>, which the Twilio path does not render yet, so it behaves like "callback".
  await captureEmergencyCallback({ businessId: business._id, callerNumber: call.callerNumber, reason: "capacity", key: `cap:twilio:${call.providerCallId}`, callId: call._id });
  // The refusal is final: close the session now so it never shows as a live call and never holds anything.
  await CallSession.updateOne({ callId: call._id, connectionKind: "twilio", endedAt: null }, { $set: { lifecycle: "failed", stage: "failed", stageAt: new Date(), status: "failed", endedAt: new Date(), terminationReason: "capacity", durationSeconds: 0 } });
  publish(business._id, "call.updated", { id: String(call._id) });
  return { kind: "say_hangup", say: CAPACITY_SAY };
}

/** The first real exchange has started: the session is active. */
export async function sessionActive(callId: Types.ObjectId | string): Promise<void> {
  try {
    const s = await CallSession.findOne({ callId, connectionKind: "twilio" }).select("_id lifecycle");
    if (s && s.lifecycle === "initializing") await markActive(s._id);
    else if (s && s.lifecycle === "incoming") { await transition(s._id, "initializing"); await markActive(s._id); }
  } catch { /* bookkeeping only */ }
}

/** The call ended (provider status callback). Frees the slot exactly once and records the cause. */
export async function endSession(callSid: string, outcome: { ok: boolean; cause?: string }): Promise<void> {
  try {
    const s = await CallSession.findOne({ connectionKind: "twilio", providerCallId: callSid });
    if (!s) return;
    const call = s.callId ? await Call.findById(s.callId).select("durationSeconds") : null;
    await CallSession.updateOne({ _id: s._id, endedAt: null }, { $set: { endedAt: new Date(), status: outcome.ok ? "completed" : "failed", terminationReason: outcome.cause ?? (outcome.ok ? "completed" : "failed"), durationSeconds: call?.durationSeconds ?? Math.round((Date.now() - s.startedAt.getTime()) / 1000) } });
    await closeSession(s._id, outcome);
    await CallSession.updateOne({ _id: s._id }, { $set: { stage: outcome.ok ? "completed" : "failed", stageAt: new Date() } });
    publish(s.businessId, "call.updated", { id: String(s.callId ?? s._id) });
  } catch (e) {
    logger.error("Could not close call session", { callSid, message: (e as Error).message });
  }
}
