import dotenv from "dotenv";
import { z } from "zod";

// Next.js loads .env.local itself; this also covers scripts run outside Next (seed, tests). First definition wins.
dotenv.config({ path: [".env.local", ".env"], quiet: true });

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017/staydesk"),
  MONGODB_URI_TEST: z.string().default("mongodb://127.0.0.1:27017/staydesk_test"),

  // Auth
  JWT_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default("7d"),
  COOKIE_SECURE: bool,

  // URLs
  /** Public URL of this app (ngrok in dev, your domain in prod). Base for links in emails and Twilio callback URLs. */
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
  /** Optional override if Twilio reaches the app on a different URL than NEXT_PUBLIC_APP_URL (e.g. ngrok while the browser uses localhost). */
  PUBLIC_BASE_URL: z.string().optional(),

  // Telephony
  TELEPHONY_PROVIDER: z.enum(["twilio", "telnyx"]).default("twilio"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** Optional: your Twilio number; the seed script attaches it to the demo business. */
  TWILIO_PHONE_NUMBER: z.string().optional(),
  /** Dev-only escape hatch. Ignored in production. */
  TWILIO_SKIP_SIGNATURE: bool,

  // AI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  VOICE_PROVIDER: z.enum(["twilio_gather", "retell", "vapi"]).default("twilio_gather"),
  RETELL_API_KEY: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  /** SIP URI of the external voice agent (Retell/Vapi) that live calls are handed to when voiceProvider != twilio_gather. */
  VOICE_SIP_URI: z.string().optional(),
  /** Shared secret that external voice agents (Retell/Vapi/custom) send as x-agent-secret to /api/agent/tool/*. */
  AGENT_TOOL_SECRET: z.string().optional(),

  // Email
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("StayDesk <alerts@staydesk.local>"),
});

// A blank `KEY=` line (as in .env.example) means "not set": drop it so defaults apply.
const source = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""));
const parsed = schema.safeParse(source);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
}

const raw = parsed.data;
const isProd = raw.NODE_ENV === "production";

const building = process.env.NEXT_PHASE === "phase-production-build";
if (isProd && !building && (!raw.JWT_SECRET || raw.JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET must be set to a random string of at least 32 characters in production.");
}
if (isProd && !building && !raw.TWILIO_AUTH_TOKEN) {
  console.warn("[config] TWILIO_AUTH_TOKEN is not set; Twilio webhooks will be rejected.");
}

export const env = {
  ...raw,
  isProd,
  /** Base URL used for links in emails. */
  FRONTEND_URL: raw.NEXT_PUBLIC_APP_URL,
  /** Base URL Twilio calls (used to verify webhook signatures and build callbacks). */
  PUBLIC_BASE_URL: raw.PUBLIC_BASE_URL ?? raw.NEXT_PUBLIC_APP_URL,
  isTest: raw.NODE_ENV === "test",
  JWT_SECRET: raw.JWT_SECRET ?? "dev-only-insecure-jwt-secret-change-me",
  COOKIE_SECURE: raw.COOKIE_SECURE || isProd,
  TWILIO_SKIP_SIGNATURE: !isProd && raw.TWILIO_SKIP_SIGNATURE,
  AGENT_TOOL_SECRET: raw.AGENT_TOOL_SECRET ?? (isProd ? undefined : "dev-agent-tool-secret"),
};

export type Env = typeof env;
