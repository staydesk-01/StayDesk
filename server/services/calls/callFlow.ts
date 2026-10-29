import type { Types } from "mongoose";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { BusinessKnowledge, Business, Call, FollowUp, OutboundCallRequest, PhoneConfiguration, RoomType, SuppressionEntry } from "../../models";
import type { BusinessDoc, CallDoc, PhoneConfigDoc, RoutingReason } from "../../models";
import { agentEngine } from "../ai/agentEngine";
import { findBusinessByNumber } from "../business/businessService";
import { getTelephony } from "../telephony";
import type { CallInstruction } from "../telephony";
import { publish } from "../realtime";
import { normalizePhone } from "../../utils/phone";
import { appendTranscript, createCallSession, finalizeCall } from "./callService";
import { decideRouting, reasonForDialFailure } from "./routingService";
import { runTurnOnce } from "../ai/turnGuard";
import { OPT_OUT, onOutboundCallEnded, recordOptOut } from "../outbound/service";
import { completeTransfer } from "./transferService";
import { flags, voiceTiming } from "../../config/flags";
import { memoryContext, recallCaller } from "../memory/customerMemory";

/**
 * Telephony-provider-agnostic call flow. Webhook controllers translate provider payloads into these calls
 * and render the returned CallInstruction with the active TelephonyProvider.
 */

const base = () => env.PUBLIC_BASE_URL.replace(/\/$/, "");
const hook = (path: string, callId: Types.ObjectId) => `${base()}/api/twilio/${path}?callId=${callId}`;

const MAX_TURNS = 40;

/** Voice settings stored on the call at pickup so every later turn uses the same language and recognition hints. */
type VoiceSettings = { language?: string; hints?: string };
const voiceOf = (call: CallDoc): VoiceSettings => ((call.agentState ?? {}) as { voice?: VoiceSettings }).voice ?? {};
const listen = (call: CallDoc, say: string): CallInstruction => {
  const t = voiceTiming();
  return { kind: "say_listen", say, actionUrl: hook("gather", call._id), ...voiceOf(call), speechTimeout: t.speechTimeout, noInputSeconds: t.noInputSeconds };
};

async function buildVoiceSettings(business: BusinessDoc): Promise<VoiceSettings> {
  // Non-English replies need the LLM brain; the built-in rule agent only speaks English, so don't pair it with another voice.
  const language = business.language !== "en-US" && agentEngine.brainName() === "openai" ? business.language : "en-US";
  const [knowledge, rooms] = await Promise.all([BusinessKnowledge.findOne({ businessId: business._id }), RoomType.find({ businessId: business._id, active: true }).select("name")]);
  const phrases = [business.name, "check in", "check out", "reservation", "confirmation code", "appointment", ...(knowledge?.services.map((s) => s.name) ?? []), ...rooms.map((r) => r.name)];
  return { language, hints: [...new Set(phrases)].join(", ").slice(0, 480) };
}
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
  const voice = await buildVoiceSettings(business);
  // Returning-caller recognition: only "has this number called before", never names or past details.
  let memory: ReturnType<typeof memoryContext> | undefined;
  try {
    memory = memoryContext(await recallCaller(call.businessId, call.callerNumber));
  } catch (e) {
    logger.error("Caller memory lookup failed; continuing without it", { message: (e as Error).message });
  }
  await Call.updateOne({ _id: call._id }, { $set: { "agentState.voice": voice, ...(memory ? { "agentState.memory": memory } : {}) } });
  call.agentState = { ...(call.agentState ?? {}), voice, ...(memory ? { memory } : {}) };
  const say = await agentEngine.greet(call);
  return listen(call, say);
}

const PURPOSE_LINE: Record<string, string> = {
  reservation_reminder: "I'm calling to remind you about your reservation.",
  customer_callback: "You asked us to call you back.",
  order_status: "I'm calling with an update on your order.",
  approved_follow_up: "I'm following up on your recent inquiry.",
};

/**
 * The person we called picked up. Says who is calling, that it is an AI, why, and how to opt out; then the normal
 * conversation takes over. A number added to the do-not-call list after the call was placed is not spoken to.
 */
export async function handleOutboundAnswer(callId: string, requestId: string): Promise<CallInstruction> {
  const [call, request] = await Promise.all([Call.findById(callId), OutboundCallRequest.findById(requestId)]);
  if (!call || !request || String(request.callId) !== String(call._id) || call.endedAt) return { kind: "say_hangup" };
  const business = await Business.findById(call.businessId);
  if (!business) return { kind: "say_hangup" };
  if ((await SuppressionEntry.exists({ businessId: call.businessId, phone: call.callerNumber })) || request.status === "cancelled") return { kind: "say_hangup" };

  call.status = "ai_answered";
  call.answeredAt = new Date();
  await call.save();
  publish(call.businessId, "call.updated", { id: String(call._id) });
  const voice = await buildVoiceSettings(business);
  await Call.updateOne({ _id: call._id }, { $set: { "agentState.voice": voice } });
  call.agentState = { ...(call.agentState ?? {}), voice };
  const who = request.recipientName ? `Hello ${request.recipientName.split(" ")[0]}, this` : "Hello, this";
  const say = `${who} is ${business.agentName}, an AI assistant calling from ${business.name}. ${PURPOSE_LINE[request.purpose] ?? ""} ${request.message ? `${request.message} ` : ""}If you'd rather not get these calls, just say stop calling. How can I help?`.replace(/\s+/g, " ");
  await appendTranscript(call, "agent", say);
  return listen(call, say);
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

/**
 * One conversational turn, with timing and recovery: the webhook round trip is measured, and an unexpected error
 * during a turn is answered honestly ("could you say that again?") instead of dropping the caller. After repeated errors the
 * caller is told a human will call back and a high-priority follow-up is created.
 */
export async function handleGather(callId: string, p: { speech?: string; idempotencyKey?: string }): Promise<CallInstruction> {
  // Twilio re-sends a webhook with the same idempotency token when it did not get (or did not accept) our answer:
  // the second delivery gets the first answer back and nothing runs twice.
  const { result } = await runTurnOnce(callId, p.idempotencyKey ? `tw-${p.idempotencyKey}`.slice(0, 80) : undefined, () => gatherWithRecovery(callId, p));
  return result;
}

async function gatherWithRecovery(callId: string, p: { speech?: string }): Promise<CallInstruction> {
  const started = Date.now();
  try {
    const instruction = await gatherTurn(callId, p);
    const ms = Date.now() - started;
    await Call.updateOne({ _id: callId }, { $inc: { "voice.turns": 1, "voice.totalWebhookMs": ms }, $max: { "voice.maxWebhookMs": ms } }).catch(() => undefined);
    return instruction;
  } catch (e) {
    if (!flags.resilientTurns()) throw e;
    logger.error("Conversation turn failed; recovering", { callId, message: (e as Error).message, stack: (e as Error).stack });
    const call = await Call.findByIdAndUpdate(callId, { $inc: { "voice.recoveredErrors": 1 } }, { returnDocument: "after" });
    if (!call || call.endedAt) return { kind: "empty" };
    if ((call.voice?.recoveredErrors ?? 0) >= 3) {
      await FollowUp.create({
        businessId: call.businessId, callId: call._id, customerName: call.callerName, phone: call.callerNumber, priority: "high",
        reason: "The AI assistant kept hitting technical errors during this call, so the caller was told someone would call back. Nothing they asked for was completed.",
        isDemo: call.isDemo,
      });
      return { kind: "say_hangup", say: "I'm sorry, I'm having technical trouble and can't help with that right now. I've asked our team to call you back at this number. Goodbye." };
    }
    const say = "Sorry, I had a problem with that. Could you say it again, please?";
    await appendTranscript(call, "agent", say);
    return listen(call, say);
  }
}

async function gatherTurn(callId: string, p: { speech?: string }): Promise<CallInstruction> {
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
    return listen(call, say);
  }

  // Outbound calls: asking to stop is honoured immediately and permanently, before anything else is processed.
  if (call.direction === "outbound" && OPT_OUT.test(speech)) {
    await recordOptOut(call.businessId, call.callerNumber, "Said stop on an outbound call");
    await appendTranscript(call, "caller", speech);
    return { kind: "say_hangup", say: "Understood. We won't call you again. Goodbye." };
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
  return listen((await Call.findById(call._id)) ?? call, result.reply);
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
  return listen((await Call.findById(call._id)) ?? call, say);
}

/** Provider call-status callback. Finalizes the call exactly once. */
export async function handleStatus(p: { callSid: string; callStatus: string; duration?: number }): Promise<void> {
  const call = await Call.findOne({ provider: "twilio", providerCallId: p.callSid });
  if (!call) return;
  const isOutbound = call.direction === "outbound";
  const finish = async (hook: string) => { if (isOutbound) await onOutboundCallEnded(call._id, hook); };
  switch (p.callStatus) {
    case "completed":
      await finalizeCall(call._id, { durationSeconds: p.duration && p.duration > 0 ? p.duration : undefined });
      await finish("completed");
      break;
    case "busy":
    case "failed":
    case "no-answer":
      await finalizeCall(call._id, { forceStatus: "failed" });
      await finish(p.callStatus);
      break;
    case "canceled":
      await finalizeCall(call._id, { forceStatus: "abandoned" });
      await finish("canceled");
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
