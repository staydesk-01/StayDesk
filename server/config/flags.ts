/**
 * Feature flags for incremental rollout. Read at call time (not import time) so tests and deployments can change them.
 * Set to "true"/"1" or "false"/"0" in the environment. Defaults keep today's behaviour unless noted.
 */
const read = (key: string, fallback: boolean) => {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
};

export const flags = {
  /** Remember returning callers (per business, by caller number) and keep a short history. Stores minimal data for medical businesses. */
  customerMemory: () => read("FEATURE_CUSTOMER_MEMORY", true),
  /** Greet recognised callers with "Welcome back". Never uses a name or past details before the caller verifies. Off by default. */
  returningGreeting: () => read("FEATURE_RETURNING_GREETING", false),
  /** Record original request, attempted actions, real outcomes, failures and next steps on every call. */
  completionTracking: () => read("FEATURE_COMPLETION_TRACKING", true),
  /** If a turn fails unexpectedly, apologise and keep the call going instead of hanging up. */
  resilientTurns: () => read("FEATURE_RESILIENT_TURNS", true),
  /** Telephony control plane: connections, numbers, call sessions, health, failover. Existing Twilio calling is unchanged when off. */
  telephonyCore: () => read("FEATURE_TELEPHONY_CORE", false),
  /** Accept signed events from a self-hosted SIP gateway worker. Needs `telephonyCore`. */
  sipGateway: () => read("FEATURE_SIP_GATEWAY", false),
  /** Outbound calling. Off by default; each business must also enable it and each purpose must be approved. */
  outboundCalling: () => read("FEATURE_OUTBOUND_CALLING", false),
  /** Apply VOICE_SPEECH_TIMEOUT / VOICE_NO_INPUT_SECONDS to the speech recogniser. Off by default; effect needs a live call to judge. */
  voiceTuning: () => read("FEATURE_VOICE_TUNING", false),
};

/** Speech-recognition timing used when `voiceTuning` is on. `speechTimeout`: "auto" or seconds of silence that end a turn. */
export function voiceTiming(): { speechTimeout: "auto" | number; noInputSeconds: number } {
  const defaults = { speechTimeout: "auto" as const, noInputSeconds: 6 };
  if (!flags.voiceTuning()) return defaults;
  const st = process.env.VOICE_SPEECH_TIMEOUT;
  const n = Number(process.env.VOICE_NO_INPUT_SECONDS);
  const secs = Number(st);
  return {
    speechTimeout: st && st !== "auto" && Number.isFinite(secs) && secs >= 1 && secs <= 10 ? Math.round(secs) : "auto",
    noInputSeconds: Number.isFinite(n) && n >= 3 && n <= 15 ? Math.round(n) : 6,
  };
}
