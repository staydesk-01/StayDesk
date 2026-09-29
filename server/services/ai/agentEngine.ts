import type { Types } from "mongoose";
import { logger } from "../../config/logger";
import { Business, BusinessKnowledge, Call, CallTranscript, PhoneConfiguration } from "../../models";
import type { CallDoc } from "../../models";
import { AppError } from "../../utils/errors";
import { appendTranscript, bumpIntent } from "../calls/callService";
import { classifyIntent } from "./intent";
import { getOpenAI } from "./openaiClient";
import { OpenAiBrain } from "./openaiAgent";
import { buildGreeting } from "./prompt";
import { RuleBrain } from "./ruleAgent";
import type { AgentBrain, AgentTurnResult } from "./types";

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
    const text = buildGreeting(call, business);
    await appendTranscript(call, "agent", text);
    return text;
  },

  async respond(callId: Types.ObjectId | string, userText: string): Promise<AgentTurnResult & { intent: string }> {
    const { call, business, knowledge, config, transcript } = await load(callId);
    await appendTranscript(call, "caller", userText);
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
      const fresh = (await Call.findById(call._id)) ?? call;
      result = await ruleBrain.respond({ call: fresh, business, knowledge, config, history, userText });
    }
    await appendTranscript(call, "agent", result.reply);
    const after = await Call.findById(call._id).select("intent");
    return { ...result, intent: after?.intent ?? "unknown" };
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
