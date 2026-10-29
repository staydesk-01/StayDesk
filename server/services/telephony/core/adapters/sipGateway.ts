import crypto from "node:crypto";
import type { ConnectionContext, HealthResult, TelephonyAdapter, OutboundRequest } from "../types";
import { TelephonyError, withTimeout } from "../types";

/**
 * Control-plane adapter for a self-managed SIP gateway (LiveKit SIP + the voice worker). StayDesk never touches
 * SIP/RTP itself: it sends signed commands to the gateway's control API and receives signed events back.
 * Signature = HMAC-SHA256(secret, `${timestamp}.${body}`), accepted for 5 minutes (replay protection).
 */
let doFetch: typeof fetch = (...a) => fetch(...a);
export const __setSipFetchForTest = (f: typeof fetch | null) => { doFetch = f ?? ((...a) => fetch(...a)); };

export const signPayload = (secret: string, timestamp: number, body: string) => crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

export function verifySignature(secret: string | undefined, timestampHeader: string | null | undefined, signature: string | null | undefined, body: string, now = Date.now()): boolean {
  if (!secret || !timestampHeader || !signature) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > 5 * 60_000) return false;
  const expected = Buffer.from(signPayload(secret, ts, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Only HTTPS control URLs, except loopback for local development. Never plain HTTP across a network. */
export function controlUrlProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return "Gateway control URL is missing.";
  let u: URL;
  try { u = new URL(raw); } catch { return "Gateway control URL is not a valid URL."; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return "Gateway control URL must use HTTPS.";
  if (u.username || u.password) return "Do not put credentials in the gateway URL.";
  return null;
}

async function signedFetch(ctx: ConnectionContext, path: string, init: { method: string; body?: unknown }, label: string, timeoutMs: number) {
  const secret = ctx.secret("controlSecret");
  const problem = controlUrlProblem(ctx.settings.controlUrl);
  if (!secret || problem) throw new TelephonyError("not_configured", problem ?? "Gateway control secret is missing.");
  const body = init.body === undefined ? "" : JSON.stringify(init.body);
  const ts = Math.floor(Date.now() / 1000);
  return withTimeout(timeoutMs, label, (signal) =>
    doFetch(new URL(path, String(ctx.settings.controlUrl)).toString(), {
      method: init.method,
      headers: { "Content-Type": "application/json", "x-staydesk-timestamp": String(ts), "x-staydesk-signature": signPayload(secret, ts, body) },
      body: body || undefined,
      signal,
    }),
  );
}

export const sipGatewayAdapter: TelephonyAdapter = {
  kind: "sip_gateway",
  capabilities: { inbound: true, outbound: true, dtmf: true, audioStreaming: true, healthCheck: true },
  validate(ctx) {
    const p: string[] = [];
    const bad = controlUrlProblem(ctx.settings.controlUrl);
    if (bad) p.push(bad);
    if (!ctx.secret("controlSecret") || (ctx.secret("controlSecret") ?? "").length < 32) p.push("Gateway control secret must be at least 32 characters.");
    return p;
  },
  async checkHealth(ctx): Promise<HealthResult> {
    const t0 = Date.now();
    const res = await signedFetch(ctx, "/health", { method: "GET" }, "SIP gateway health check", 5000);
    if (!res.ok) throw new TelephonyError("provider_error", `SIP gateway responded ${res.status}`);
    return { ok: true, latencyMs: Date.now() - t0, detail: "SIP gateway control API reachable" };
  },
  async startOutbound(ctx, req: OutboundRequest) {
    const res = await signedFetch(ctx, "/calls", { method: "POST", body: { from: req.from, to: req.to, callId: req.callId, statusCallbackUrl: req.statusCallbackUrl } }, "SIP gateway call create", 10_000);
    if (!res.ok) throw new TelephonyError("provider_error", `SIP gateway responded ${res.status}`);
    const body = (await res.json()) as { providerCallId?: string };
    if (!body.providerCallId) throw new TelephonyError("provider_error", "SIP gateway did not return a call id");
    return { providerCallId: body.providerCallId };
  },
  async hangup(ctx, providerCallId) {
    const res = await signedFetch(ctx, `/calls/${encodeURIComponent(providerCallId)}`, { method: "DELETE" }, "SIP gateway hang-up", 8000);
    if (!res.ok && res.status !== 404) throw new TelephonyError("provider_error", `SIP gateway responded ${res.status}`);
  },
};
