import type OpenAI from "openai";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { Call } from "../../models";
import { runTool, toolSpecsForLlm } from "../../tools/registry";
import { buildSystemPrompt } from "./prompt";
import type { AgentBrain, AgentTurnResult, BrainInput } from "./types";

const END_CALL_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "end_call",
    description: "Hang up after speaking a brief goodbye. Only use when the caller is finished.",
    parameters: { type: "object", properties: { goodbye: { type: "string", description: "Short goodbye to speak" } }, required: ["goodbye"] },
  },
};

const MAX_STEPS = 6;
const DEADLINE_MS = 10_000; // Twilio abandons webhooks after ~15s

/** LLM brain: OpenAI chat completions with backend tool calling. The model never sees or supplies businessId/callId. */
export class OpenAiBrain implements AgentBrain {
  constructor(private client: OpenAI) {}

  async respond({ call, business, knowledge, history, userText }: BrainInput): Promise<AgentTurnResult> {
    const started = Date.now();
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: buildSystemPrompt(call, business, knowledge) },
      ...history.slice(-30).map((h) => ({ role: h.role === "caller" ? ("user" as const) : ("assistant" as const), content: h.text })),
      { role: "user", content: userText },
    ];
    const tools = [...toolSpecsForLlm(), END_CALL_TOOL];
    const ctx = { businessId: call.businessId, callId: call._id };
    let end = false;
    let goodbye = "";

    for (let step = 0; step < MAX_STEPS; step++) {
      if (Date.now() - started > DEADLINE_MS) throw new Error("LLM deadline exceeded");
      const res = await this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages,
        tools,
        temperature: 0.3,
        max_completion_tokens: 220,
      });
      const msg = res.choices[0]?.message;
      if (!msg) throw new Error("Empty LLM response");
      messages.push(msg);

      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
      if (!calls.length) {
        const fresh = await Call.findById(call._id).select("pendingTransfer");
        return { reply: msg.content?.trim() || goodbye || "Is there anything else I can help you with?", end, transfer: !!fresh?.pendingTransfer };
      }

      for (const c of calls) {
        if (c.function.name === "end_call") {
          end = true;
          try {
            goodbye = String(JSON.parse(c.function.arguments || "{}").goodbye ?? "");
          } catch {
            /* ignore */
          }
          messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ ok: true }) });
          continue;
        }
        let args: unknown = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          /* validation error is returned to the model below */
        }
        const result = await runTool(c.function.name, ctx, args);
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
      }

      if (end) {
        // The model asked to hang up; let it speak the goodbye it supplied.
        return { reply: goodbye || "Thank you for calling. Goodbye!", end: true, transfer: false };
      }
      const fresh = await Call.findById(call._id).select("pendingTransfer");
      if (fresh?.pendingTransfer) {
        const spoken = msg.content?.trim();
        return { reply: spoken || "Please hold while I connect you to our team.", end: false, transfer: true };
      }
    }
    logger.warn("LLM exceeded max tool steps");
    return { reply: "Let me have a team member follow up with you on that. Is there anything else I can help with?", end: false, transfer: false };
  }
}
