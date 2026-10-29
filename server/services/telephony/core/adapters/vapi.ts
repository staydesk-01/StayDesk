import type { HealthResult, TelephonyAdapter, OutboundRequest } from "../types";
import { TelephonyError, withTimeout } from "../types";

/**
 * Vapi control-plane adapter. Inbound tool/end-of-call events are handled by services/ai/voice/vapi.ts.
 * The REST calls below follow Vapi's documented API but have NOT been run against a live Vapi account.
 */
let doFetch: typeof fetch = (...a) => fetch(...a);
export const __setVapiFetchForTest = (f: typeof fetch | null) => { doFetch = f ?? ((...a) => fetch(...a)); };
const BASE = "https://api.vapi.ai";

export const vapiAdapter: TelephonyAdapter = {
  kind: "vapi",
  capabilities: { inbound: true, outbound: true, dtmf: false, audioStreaming: false, healthCheck: true },
  validate(ctx) {
    const p: string[] = [];
    if (!ctx.secret("apiKey")) p.push("Vapi API key is missing.");
    if (!ctx.settings.assistantId) p.push("Vapi assistant id is missing.");
    if (!ctx.settings.phoneNumberId) p.push("Vapi phone number id is missing (needed for outbound calls).");
    return p;
  },
  async checkHealth(ctx): Promise<HealthResult> {
    const key = ctx.secret("apiKey");
    if (!key) throw new TelephonyError("not_configured", "Vapi API key is not set.");
    const t0 = Date.now();
    const res = await withTimeout(5000, "Vapi health check", (signal) => doFetch(`${BASE}/assistant?limit=1`, { headers: { Authorization: `Bearer ${key}` }, signal }));
    if (!res.ok) throw new TelephonyError("provider_error", `Vapi responded ${res.status}`);
    return { ok: true, latencyMs: Date.now() - t0, detail: "Vapi API reachable" };
  },
  async startOutbound(ctx, req: OutboundRequest) {
    const key = ctx.secret("apiKey");
    if (!key || !ctx.settings.assistantId || !ctx.settings.phoneNumberId) throw new TelephonyError("not_configured", "Vapi is not fully configured.");
    const res = await withTimeout(10_000, "Vapi call create", (signal) =>
      doFetch(`${BASE}/call`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ assistantId: ctx.settings.assistantId, phoneNumberId: ctx.settings.phoneNumberId, customer: { number: req.to }, metadata: { staydesk_call_id: req.callId } }),
        signal,
      }),
    );
    if (!res.ok) throw new TelephonyError("provider_error", `Vapi responded ${res.status}`);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new TelephonyError("provider_error", "Vapi did not return a call id");
    return { providerCallId: body.id };
  },
  async hangup() {
    throw new TelephonyError("not_supported", "Hang-up through Vapi is not implemented.");
  },
};
