import { env } from "../../../config/env";
import { secretMatches, sharedSecretOk, type VoiceEvent, type VoiceProvider } from "./provider";

/**
 * Vapi adapter (experimental – not verified against a live Vapi account).
 * Set the assistant's server URL to /api/voice/vapi with `x-vapi-secret` (VAPI_WEBHOOK_SECRET)
 * and pass `staydesk_call_id` in the call metadata.
 */
export const vapiProvider: VoiceProvider = {
  name: "vapi",
  verify: (req) => secretMatches(req.header("x-vapi-secret"), env.VAPI_WEBHOOK_SECRET) || sharedSecretOk(req),
  parse(body): VoiceEvent[] {
    const msg = body?.message ?? {};
    const callRef = msg.call?.metadata?.staydesk_call_id;
    if (!callRef) return [];
    if (msg.type === "tool-calls") {
      return (msg.toolCallList ?? []).map((t: any) => ({
        type: "tool_call" as const,
        callRef,
        toolCallId: t.id,
        name: t.function?.name ?? t.name,
        args: typeof t.function?.arguments === "string" ? safeJson(t.function.arguments) : (t.function?.arguments ?? {}),
      }));
    }
    if (msg.type === "end-of-call-report") {
      const messages: any[] = msg.artifact?.messages ?? msg.messages ?? [];
      return [
        {
          type: "call_ended",
          callRef,
          durationSeconds: msg.durationSeconds ? Math.round(msg.durationSeconds) : undefined,
          transcript: messages
            .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "bot")
            .map((m) => ({ role: m.role === "user" ? ("caller" as const) : ("agent" as const), text: String(m.message ?? m.content ?? "") })),
        },
      ];
    }
    return [];
  },
  toolResponse: (event, result) => ({ results: [{ toolCallId: event.toolCallId, result: JSON.stringify(result) }] }),
};

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
