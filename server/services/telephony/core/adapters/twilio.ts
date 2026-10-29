import twilio from "twilio";
import { env } from "../../../../config/env";
import type { ConnectionContext, HealthResult, TelephonyAdapter, OutboundRequest } from "../types";
import { TelephonyError, withTimeout } from "../types";

/** Control-plane adapter for the existing Twilio integration (inbound webhooks stay in telephony/twilio.ts + callFlow). */
type Rest = ReturnType<typeof twilio>;
let factory: (sid: string, token: string) => Rest = (sid, token) => twilio(sid, token);
/** Test hook: replace the Twilio REST client. */
export const __setTwilioRestForTest = (f: typeof factory | null) => { factory = f ?? ((sid, token) => twilio(sid, token)); };

const creds = (ctx: ConnectionContext) => ({ sid: ctx.secret("accountSid") ?? env.TWILIO_ACCOUNT_SID, token: ctx.secret("authToken") ?? env.TWILIO_AUTH_TOKEN });

export const twilioAdapter: TelephonyAdapter = {
  kind: "twilio",
  capabilities: { inbound: true, outbound: true, dtmf: false, audioStreaming: false, healthCheck: true },
  validate(ctx) {
    const { sid, token } = creds(ctx);
    const problems: string[] = [];
    if (!sid || !/^AC[0-9a-f]{32}$/i.test(sid)) problems.push("Twilio account SID is missing or malformed.");
    if (!token) problems.push("Twilio auth token is missing.");
    return problems;
  },
  async checkHealth(ctx): Promise<HealthResult> {
    const { sid, token } = creds(ctx);
    if (!sid || !token) throw new TelephonyError("not_configured", "Twilio credentials are not set.");
    const t0 = Date.now();
    await withTimeout(5000, "Twilio health check", () => factory(sid, token).api.accounts(sid).fetch());
    return { ok: true, latencyMs: Date.now() - t0, detail: "Twilio account reachable" };
  },
  async startOutbound(ctx, req: OutboundRequest) {
    const { sid, token } = creds(ctx);
    if (!sid || !token) throw new TelephonyError("not_configured", "Twilio credentials are not set.");
    const call = await withTimeout(10_000, "Twilio call create", () =>
      factory(sid, token).calls.create({ from: req.from, to: req.to, url: req.answerUrl, method: "POST", statusCallback: req.statusCallbackUrl, statusCallbackMethod: "POST", statusCallbackEvent: ["completed"] }),
    );
    return { providerCallId: call.sid };
  },
  async hangup(ctx, providerCallId) {
    const { sid, token } = creds(ctx);
    if (!sid || !token) throw new TelephonyError("not_configured", "Twilio credentials are not set.");
    await withTimeout(8000, "Twilio hangup", () => factory(sid, token).calls(providerCallId).update({ status: "completed" }));
  },
};
