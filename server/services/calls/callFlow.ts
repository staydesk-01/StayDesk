import type { Types } from "mongoose";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { BusinessKnowledge, Business, Call, PhoneConfiguration } from "../../models";
import type { BusinessDoc, CallDoc, PhoneConfigDoc, RoutingReason } from "../../models";
import { agentEngine } from "../ai/agentEngine";
import { findBusinessByNumber } from "../business/businessService";
import { getTelephony } from "../telephony";
import type { CallInstruction } from "../telephony";
import { publish } from "../realtime";
import { normalizePhone } from "../../utils/phone";
import { appendTranscript, createCallSession, finalizeCall } from "./callService";
import { decideRouting, reasonForDialFailure } from "./routingService";
import { completeTransfer } from "./transferService";

/**
 * Telephony-provider-agnostic call flow. Webhook controllers translate provider payloads into these calls
 * and render the returned CallInstruction with the active TelephonyProvider.
 */

const base = () => env.PUBLIC_BASE_URL.replace(/\/$/, "");
const hook = (path: string, callId: Types.ObjectId) => `${base()}/api/twilio/${path}?callId=${callId}`;

const MAX_TURNS = 40;
export const TECH_DIFFICULTIES: CallInstruction = {
  kind: "say_hangup",
  say: "I'm sorry, we're having technical difficulties. Please call back in a few minutes. Goodbye.",
};

export async function handleIncoming(p: { callSid: string; from: string; to: string }): Promise<CallInstruction> {
  const found = await findBusinessByNumber(p.to);
  if (!found) {
    logger.warn("Incoming call for unknown number", { to: p.to });
    return { kind: "say_hangup", say: "Sorry, this number is not currently in service. Goodbye." };
  }
  const { business, config } = found;
  const from = normalizePhone(p.from) || p.from;

  // Agent switched off → behave like a plain phone line.
  if (!config.agentActive) {
    const number = config.humanNumber || business.escalationPhone;
    const call = await createCallSession({
      businessId: business._id, provider: "twilio", providerCallId: p.callSid, callerNumber: from,
      businessNumber: config.twilioNumber ?? p.to, routingReason: "direct_ai", handledBy: "human",
    });
    return number
      ? { kind: "dial", number: normalizePhone(number), ringSeconds: config.ringSeconds, actionUrl: hook("dial-result", call._id) }
      : { kind: "say_hangup", say: "We're unable to take your call right now. Please try again later. Goodbye." };
  }

  const knowledge = await BusinessKnowledge.findOne({ businessId: business._id });
  const decision = await decideRouting({ business, config, knowledge });

  if (decision.route === "human") {
    const call = await createCallSession({
      businessId: business._id, provider: "twilio", providerCallId: p.callSid, callerNumber: from,
      businessNumber: config.twilioNumber ?? p.to, routingReason: "direct_ai", handledBy: "human", status: "ringing",
    });
    return { kind: "dial", number: decision.number, ringSeconds: decision.ringSeconds, actionUrl: hook("dial-result", call._id) };
  }

  const call = await createCallSession({
    businessId: business._id, provider: "twilio", providerCallId: p.callSid, callerNumber: from,
    businessNumber: config.twilioNumber ?? p.to, routingReason: decision.reason, handledBy: "ai", status: "ringing",
  });
  return startAiSession(call, business, config);
}

export async function startAiSession(call: CallDoc, business: BusinessDoc, config: PhoneConfigDoc): Promise<CallInstruction> {
  call.status = "ai_answered";
  call.handledBy = "ai";
  call.answeredAt = new Date();
  await call.save();
  publish(call.businessId, "call.updated", { id: String(call._id) });

  if (config.voiceProvider !== "twilio_gather" && env.VOICE_SIP_URI) {
    // External voice agent owns the audio loop; it reports back via /api/voice/:provider.
    const sep = env.VOICE_SIP_URI.includes("?") ? "&" : "?";
    return { kind: "sip", uri: `${env.VOICE_SIP_URI}${sep}X-StayDesk-Call-Id=${call._id}` };
  }

  if (business.privacy?.recordingEnabled) {
    call.recording = { ...(call.recording ?? {}), enabled: true } as CallDoc["recording"];
    await call.save();
    void getTelephony().startRecording(call.providerCallId, `${base()}/api/twilio/recording`);
  }
  const say = await agentEngine.greet(call);
  return { kind: "say_listen", say, actionUrl: hook("gather", call._id) };
}

/** Result of ringing the human line first. */
export async function handleDialResult(callId: string, p: { dialStatus: string; dialDuration?: number }): Promise<CallInstruction> {
  const call = await Call.findById(callId);
  if (!call) return TECH_DIFFICULTIES;
  if (call.endedAt) return { kind: "empty" };

  if (p.dialStatus === "completed" || p.dialStatus === "answered") {
    const now = new Date();
    call.answeredAt = new Date(now.getTime() - (p.dialDuration ?? 0) * 1000);
    call.status = "completed";
    call.handledBy = "human";
    await call.save();
    publish(call.businessId, "call.updated", { id: String(call._id) });
    return { kind: "empty" };
  }
  if (p.dialStatus === "canceled") {
    call.status = "abandoned";
    await call.save();
    return { kind: "empty" };
  }

  const [business, config] = await Promise.all([Business.findById(call.businessId), PhoneConfiguration.findOne({ businessId: call.businessId })]);
  if (!business || !config) return TECH_DIFFICULTIES;
  const reason: RoutingReason | null = reasonForDialFailure(p.dialStatus, config);
  if (!reason) {
    call.status = "abandoned";
    await call.save();
    return { kind: "say_hangup", say: "Sorry, nobody is available right now. Please try again later. Goodbye." };
  }
  call.routingReason = reason;
  call.handledBy = "ai";
  await call.save();
  return startAiSession(call, business, config);
}

/** One conversational turn. */
export async function handleGather(callId: string, p: { speech?: string }): Promise<CallInstruction> {
  const call = await Call.findById(callId);
  if (!call || call.endedAt) return { kind: "empty" };
  const state = (call.agentState ?? {}) as { silentTurns?: number; turns?: number };
  const speech = p.speech?.trim();

  if (!speech) {
    const silent = (state.silentTurns ?? 0) + 1;
    await Call.updateOne({ _id: call._id }, { $set: { "agentState.silentTurns": silent } });
    if (silent >= 3) return { kind: "say_hangup", say: "I'm not hearing anything, so I'll let you go. Please call back any time. Goodbye." };
    const say = silent === 1 ? "Sorry, I didn't catch that. How can I help you?" : "I'm still here. Could you tell me how I can help?";
    await appendTranscript(call, "agent", say);
    return { kind: "say_listen", say, actionUrl: hook("gather", call._id) };
  }

  const turns = (state.turns ?? 0) + 1;
  await Call.updateOne({ _id: call._id }, { $set: { "agentState.silentTurns": 0, "agentState.turns": turns } });
  const result = await agentEngine.respond(call._id, speech);

  if (turns >= MAX_TURNS && !result.end) return { kind: "say_hangup", say: `${result.reply} Thank you for calling. Goodbye.` };
  if (result.end) return { kind: "say_hangup", say: result.reply };
  if (result.transfer) {
    const fresh = await Call.findById(call._id);
    const number = fresh?.transfer?.transferNumber;
    if (number) return { kind: "dial", say: result.reply, number, ringSeconds: 25, actionUrl: hook("transfer-result", call._id) };
  }
  return { kind: "say_listen", say: result.reply, actionUrl: hook("gather", call._id) };
}

/** Outcome of the AI → human transfer <Dial>. */
export async function handleTransferResult(callId: string, p: { dialStatus: string }): Promise<CallInstruction> {
  const call = await Call.findById(callId);
  if (!call || call.endedAt) return { kind: "empty" };

  if (p.dialStatus === "completed" || p.dialStatus === "answered") {
    await completeTransfer(call._id, { answered: true });
    return { kind: "empty" };
  }
  await completeTransfer(call._id, { answered: false, failure: p.dialStatus === "busy" || p.dialStatus === "failed" ? "failed" : "no_answer" });
  if (p.dialStatus === "canceled") return { kind: "empty" };
  const say = await agentEngine.resumeAfterFailedTransfer(call._id);
  return { kind: "say_listen", say, actionUrl: hook("gather", call._id) };
}

/** Provider call-status callback. Finalizes the call exactly once. */
export async function handleStatus(p: { callSid: string; callStatus: string; duration?: number }): Promise<void> {
  const call = await Call.findOne({ provider: "twilio", providerCallId: p.callSid });
  if (!call) return;
  switch (p.callStatus) {
    case "completed":
      await finalizeCall(call._id, { durationSeconds: p.duration && p.duration > 0 ? p.duration : undefined });
      break;
    case "busy":
    case "failed":
    case "no-answer":
      await finalizeCall(call._id, { forceStatus: "failed" });
      break;
    case "canceled":
      await finalizeCall(call._id, { forceStatus: "abandoned" });
      break;
    default:
      break; // initiated / ringing / in-progress: nothing to do
  }
}

export async function handleRecording(p: { callSid: string; url?: string; sid?: string; duration?: number }): Promise<void> {
  const call = await Call.findOne({ provider: "twilio", providerCallId: p.callSid });
  if (!call) return;
  const business = await Business.findById(call.businessId).select("privacy");
  // Never keep a recording for a business that has not enabled recording.
  if (!business?.privacy?.recordingEnabled) return;
  call.recording = { enabled: true, url: p.url, sid: p.sid, durationSeconds: p.duration } as CallDoc["recording"];
  await call.save();
}
