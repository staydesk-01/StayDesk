import { sharedSecretOk, type VoiceEvent, type VoiceProvider } from "./provider";

/**
 * Retell adapter (experimental – not verified against a live Retell account).
 * Configure each Retell custom function to POST to /api/voice/retell with header `x-agent-secret`,
 * and pass `staydesk_call_id` as call metadata / dynamic variable.
 */
export const retellProvider: VoiceProvider = {
  name: "retell",
  verify: sharedSecretOk,
  parse(body): VoiceEvent[] {
    const call = body?.call ?? {};
    const callRef = call.metadata?.staydesk_call_id ?? call.retell_llm_dynamic_variables?.staydesk_call_id;
    if (!callRef) return [];
    if (body?.event === "call_ended") {
      return [
        {
          type: "call_ended",
          callRef,
          durationSeconds: call.duration_ms ? Math.round(call.duration_ms / 1000) : undefined,
          transcript: (call.transcript_object ?? []).map((t: any) => ({ role: t.role === "agent" ? "agent" : "caller", text: String(t.content ?? "") })),
        },
      ];
    }
    if (body?.name) return [{ type: "tool_call", callRef, toolCallId: String(body.name), name: body.name, args: body.args ?? {} }];
    return [];
  },
  toolResponse: (_event, result) => result,
};
