import type { Request } from "../../../http";
import { env } from "../../../config/env";
import crypto from "node:crypto";

export type VoiceEvent =
  | { type: "tool_call"; callRef: string; toolCallId: string; name: string; args: unknown }
  | { type: "call_ended"; callRef: string; durationSeconds?: number; transcript: { role: "agent" | "caller"; text: string }[] };

/**
 * An external voice-agent provider (Retell, Vapi, later OpenAI Realtime) that owns the audio loop.
 * StayDesk stays the system of record: the provider calls our tool endpoint and reports the finished call.
 * `callRef` is the StayDesk Call id, passed to the provider as metadata / a SIP header when the call is handed off.
 */
export interface VoiceProvider {
  readonly name: "retell" | "vapi";
  verify(req: Request): boolean;
  parse(body: any): VoiceEvent[];
  /** Shape the tool result the way the provider expects. */
  toolResponse(event: Extract<VoiceEvent, { type: "tool_call" }>, result: unknown): unknown;
}

export function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const sharedSecretOk = (req: Request) => secretMatches(req.header("x-agent-secret"), env.AGENT_TOOL_SECRET);
