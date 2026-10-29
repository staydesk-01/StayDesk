import type { Types } from "mongoose";
import type { ConnectionKind } from "../../../models";

/**
 * Provider-independent telephony contract. Carrier routing (which network carries the call) is described here and is
 * deliberately separate from AI model selection (which STT / LLM / TTS thinks and talks): see agent provider configs.
 */
export type CallStatusEvent = "ringing" | "answered" | "in_progress" | "completed" | "failed" | "no_answer" | "busy" | "canceled";

export type TelephonyEvent =
  | { type: "incoming"; providerCallId: string; from: string; to: string }
  | { type: "status"; providerCallId: string; status: CallStatusEvent; reason?: string; durationSeconds?: number }
  | { type: "dtmf"; providerCallId: string; digits: string }
  | { type: "quality"; providerCallId: string; jitterMs?: number; packetLossPct?: number; rttMs?: number; mos?: number }
  | { type: "latency"; providerCallId: string; turnMs: number }
  | { type: "heartbeat"; activeCalls?: number };

export interface AdapterCapabilities {
  inbound: boolean;
  outbound: boolean;
  dtmf: boolean;
  /** The provider can stream call audio to a voice worker (needed for the self-managed voice pipeline). */
  audioStreaming: boolean;
  healthCheck: boolean;
}

/** What an adapter is allowed to see about one tenant's connection: settings plus decrypted secrets, only inside the call. */
export interface ConnectionContext {
  businessId: Types.ObjectId;
  connectionId?: Types.ObjectId;
  settings: Record<string, unknown>;
  secret(name: string): string | undefined;
}

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface OutboundRequest {
  from: string;
  to: string;
  /** StayDesk Call id: lets the provider hand events back to the right call. */
  callId: string;
  /** Where the provider should send call-progress events. */
  statusCallbackUrl: string;
  /** Where the provider fetches call instructions once the callee answers (TwiML-style providers). */
  answerUrl: string;
}

export class TelephonyError extends Error {
  constructor(
    public code: "not_configured" | "not_supported" | "timeout" | "provider_error" | "invalid_config" | "circuit_open",
    message: string,
  ) {
    super(message);
  }
}

export interface TelephonyAdapter {
  readonly kind: ConnectionKind;
  readonly capabilities: AdapterCapabilities;
  /** Validates settings/secrets without any network access. Returns human-readable problems (empty = valid). */
  validate(ctx: ConnectionContext): string[];
  checkHealth(ctx: ConnectionContext): Promise<HealthResult>;
  startOutbound(ctx: ConnectionContext, req: OutboundRequest): Promise<{ providerCallId: string }>;
  hangup(ctx: ConnectionContext, providerCallId: string): Promise<void>;
}

/** Aborts a provider call that takes too long so one slow provider cannot hold up a call. */
export async function withTimeout<T>(ms: number, label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) throw new TelephonyError("timeout", `${label} timed out after ${ms} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
