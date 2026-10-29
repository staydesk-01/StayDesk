import type { Types } from "mongoose";
import { logger } from "../../config/logger";
import { flags } from "../../config/flags";
import { Business, BusinessKnowledge, Call, CallTranscript, PhoneConfiguration } from "../../models";
import type { CallDoc } from "../../models";
import { AppError } from "../../utils/errors";
import { appendTranscript, bumpIntent } from "../calls/callService";
import { runTool } from "../../tools/registry";
import { randomUUID } from "node:crypto";
import { deriveFacts } from "./conversationState";
import { runTurnOnce } from "./turnGuard";
import { applyGuardrails, transcriptSafeText } from "./guardrails";
import { classifyIntent } from "./intent";
import { redactSensitive } from "../safety/sensitive";
import { getOpenAI } from "./openaiClient";
import { OpenAiBrain } from "./openaiAgent";
import { buildGreeting } from "./prompt";
import { RuleBrain } from "./ruleAgent";
import type { AgentBrain, AgentTurnResult } from "./types";

export type TurnResult = AgentTurnResult & { intent: string; messageId: string; responseId: string };

const ruleBrain = new RuleBrain();

function pickBrain(): { brain: AgentBrain; name: "openai" | "rules" } {
  const client = getOpenAI();
  return client ? { brain: new OpenAiBrain(client), name: "openai" } : { brain: ruleBrain, name: "rules" };
}

async function load(callId: Types.ObjectId | string) {
  const call = await Call.findById(callId);
  if (!call) throw AppError.notFound("Call not found");
  const [business, knowledge, config, transcript] = await Promise.all([
    Business.findById(call.businessId),
    BusinessKnowledge.findOne({ businessId: call.businessId }),
    PhoneConfiguration.findOne({ businessId: call.businessId }),
    CallTranscript.findOne({ callId: call._id }),
  ]);
  if (!business) throw AppError.notFound("Business not found");
  return { call, business, knowledge, config, transcript };
}

/**
 * Orchestrates a conversation turn: transcript → intent → brain (LLM with tools, or the deterministic rule brain
 * when no OPENAI_API_KEY is set / the LLM fails) → transcript. All data changes happen inside backend tools.
 */
export const agentEngine = {
  brainName: () => pickBrain().name,

  async greet(call: CallDoc): Promise<string> {
    const business = await Business.findById(call.businessId);
    if (!business) throw AppError.notFound("Business not found");
    const memory = (call.agentState as { memory?: { returning?: boolean } } | undefined)?.memory;
    // "Welcome back" only: no name and no past details until the caller identifies themselves.
    const text = buildGreeting(call, business, { returning: flags.returningGreeting() && !!memory?.returning && business.type !== "medical" });
    await appendTranscript(call, "agent", text);
    return text;
  },

  /**
   * One conversational turn. Pass `messageId` (any unique string for this caller message) to make the turn idempotent:
   * a retry with the same id returns the stored reply and does not run the agent or any backend action again.
   */
  async respond(callId: Types.ObjectId | string, userText: string, opts: { messageId?: string } = {}): Promise<TurnResult> {
    const { result } = await runTurnOnce(String(callId), opts.messageId, () => respondOnce(callId, userText, opts.messageId ?? randomUUID()));
    return result;
  },

  /** Same as respond, also telling whether this was a duplicate of an earlier request. */
  async respondWithStatus(callId: Types.ObjectId | string, userText: string, opts: { messageId?: string } = {}): Promise<TurnResult & { duplicate: boolean }> {
    const { result, duplicate } = await runTurnOnce(String(callId), opts.messageId, () => respondOnce(callId, userText, opts.messageId ?? randomUUID()));
    return { ...result, duplicate };
  },

  /** Called when a phone transfer wasn't answered: the AI resumes and keeps helping. */
  async resumeAfterFailedTransfer(callId: Types.ObjectId | string): Promise<string> {
    const call = await Call.findById(callId);
    if (!call) throw AppError.notFound("Call not found");
    const text =
      "I'm sorry, nobody on our team is available right now. I've asked them to call you back at this number. Is there anything else I can help you with?";
    await appendTranscript(call, "agent", text);
    await Call.updateOne({ _id: call._id }, { $set: { "agentState.awaiting": "more", "agentState.flow": null } });
    return text;
  },
};

async function respondOnce(callId: Types.ObjectId | string, userText: string, messageId: string): Promise<TurnResult> {
  const { call, business, knowledge, config, transcript } = await load(callId);
  const started = Date.now();
  // Speech-to-text annotations ("[noise]", "(inaudible)", "<cough>") are not words the caller said.
  userText = userText.replace(/[\[(<][^\])>]{0,30}[\])>]/g, " ").replace(/\s+/g, " ").trim() || userText;
  // Rules that hold for every brain run first (card data, "are you human?", healthcare safety).
  const guard = await applyGuardrails(call, business, userText);
  const responseId = randomUUID();
  await appendTranscript(call, "caller", transcriptSafeText(business, userText, guard), { id: messageId });
  if (guard) {
    await Call.updateOne({ _id: call._id }, { $inc: { "metrics.guardrailTriggers": 1 } });
    // Guard replies are complete answers: only an emergency changes the call's primary intent.
    await bumpIntent(call._id, guard.kind === "medical_emergency" ? "urgent_request" : "general_question");
    const latencyMs = Date.now() - started;
    await appendTranscript(call, "agent", guard.reply, { latencyMs, id: responseId, replyTo: messageId });
    await Call.updateOne({ _id: call._id }, { $inc: { "metrics.turns": 1, "metrics.totalLatencyMs": latencyMs }, $max: { "metrics.maxLatencyMs": latencyMs } });
    const after = await Call.findById(call._id).select("intent");
    return { reply: guard.reply, end: false, transfer: false, intent: after?.intent ?? "unknown", messageId, responseId };
  }
  userText = redactSensitive(userText);
  await bumpIntent(call._id, classifyIntent(userText));

  const history =
    transcript?.segments
      .filter((s): s is typeof s & { role: "caller" | "agent" } => s.role === "caller" || s.role === "agent")
      .map((s) => ({ role: s.role, text: s.text })) ?? [];

  const { brain, name } = pickBrain();
  let result: AgentTurnResult;
  try {
    // Reload so the brain sees the freshest call (intent bumps, agentState).
    const fresh = (await Call.findById(call._id)) ?? call;
    result = await brain.respond({ call: fresh, business, knowledge, config, history, userText });
  } catch (e) {
    logger.error(`Agent brain "${name}" failed; falling back to rules`, { message: (e as Error).message });
    await Call.updateOne({ _id: call._id }, { $inc: { "metrics.brainErrors": 1 } });
    const fresh = (await Call.findById(call._id)) ?? call;
    try {
      result = await ruleBrain.respond({ call: fresh, business, knowledge, config, history, userText });
    } catch (e2) {
      // Both brains failed. Never throw into the phone webhook (that would drop the caller): say so honestly and queue a callback.
      logger.error("Rule brain failed too; using the last-resort reply", { message: (e2 as Error).message });
      await runTool("create_follow_up", { businessId: call.businessId, callId: call._id }, { reason: "The AI assistant hit a technical problem during this call. Please call the customer back.", priority: "high", type: "callback" });
      result = { reply: "I'm sorry, I'm having a technical problem and can't help with that right now. I've asked our team to call you back at this number. Thank you for your patience.", end: false, transfer: false };
    }
  }
  const latencyMs = Date.now() - started;
  await appendTranscript(call, "agent", result.reply, { latencyMs, id: responseId, replyTo: messageId });
  await Call.updateOne({ _id: call._id }, { $inc: { "metrics.turns": 1, "metrics.totalLatencyMs": latencyMs }, $max: { "metrics.maxLatencyMs": latencyMs } });
  const after = await Call.findById(call._id).select("intent agentState actions callerName");
  if (after) await Call.updateOne({ _id: call._id }, { $set: { "agentState.facts": deriveFacts(after) } });
  return { ...result, intent: after?.intent ?? "unknown", messageId, responseId };
}
