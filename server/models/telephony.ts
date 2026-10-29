import { Schema } from "mongoose";
import { defineModel } from "./_define";

/**
 * Telephony control-plane records. Every document carries businessId (tenant) except system-wide health events,
 * which are keyed by provider. Credentials are stored encrypted (see utils/secrets.ts) and never returned by the API.
 */
export const CONNECTION_KINDS = ["twilio", "vapi", "sip_gateway", "livekit"] as const;
export const CONNECTION_STATUSES = ["not_configured", "testing", "connected", "degraded", "offline"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const connectionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    kind: { type: String, enum: CONNECTION_KINDS, required: true },
    label: { type: String, default: "" },
    status: { type: String, enum: CONNECTION_STATUSES, default: "not_configured" },
    statusReason: { type: String, default: "" },
    /** Non-secret settings (e.g. gateway base URL, Vapi assistant id). */
    settings: { type: Schema.Types.Mixed, default: {} },
    /** Encrypted credentials by name. Only the last 4 characters are kept readable, as a mask. */
    secrets: { type: Map, of: new Schema({ cipher: String, mask: String }, { _id: false }), default: {} },
    lastCheckedAt: Date,
    lastOkAt: Date,
    consecutiveFailures: { type: Number, default: 0 },
  },
  { timestamps: true },
);
connectionSchema.index({ businessId: 1, kind: 1 }, { unique: true });
export const TelephonyConnection = defineModel("TelephonyConnection", connectionSchema);

const trunkSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    connectionId: { type: Schema.Types.ObjectId, ref: "TelephonyConnection" },
    name: { type: String, required: true },
    direction: { type: String, enum: ["inbound", "outbound", "both"], default: "both" },
    /** Carrier signalling host. Only host:port, never credentials. */
    host: { type: String, required: true },
    transport: { type: String, enum: ["tls", "tcp", "udp"], default: "tls" },
    srtp: { type: Boolean, default: true },
    /** IPs the gateway will accept INVITEs from (empty = reject all: closed by default). */
    allowedIps: { type: [String], default: [] },
    authUsername: { type: String, default: "" },
    authPassword: { cipher: String, mask: String },
    maxConcurrentCalls: { type: Number, default: 10, min: 1, max: 1000 },
    status: { type: String, enum: CONNECTION_STATUSES, default: "not_configured" },
    lastRegisteredAt: Date,
  },
  { timestamps: true },
);
trunkSchema.index({ businessId: 1, name: 1 }, { unique: true });
export const SipTrunk = defineModel("SipTrunk", trunkSchema);

export const NUMBER_MODES = ["provider_number", "forwarding", "sip_direct", "ported"] as const;
const numberSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    /** E.164. Unique across the whole platform, so a number can never route to two businesses. */
    e164: { type: String, required: true, unique: true },
    role: { type: String, enum: ["inbound", "outbound_caller_id", "both"], default: "inbound" },
    mode: { type: String, enum: NUMBER_MODES, default: "forwarding" },
    connectionId: { type: Schema.Types.ObjectId, ref: "TelephonyConnection" },
    trunkId: { type: Schema.Types.ObjectId, ref: "SipTrunk" },
    /** all_calls: StayDesk answers first. overflow: only when staff do not answer (existing behaviour). */
    answerMode: { type: String, enum: ["all_calls", "overflow"], default: "overflow" },
    verification: {
      status: { type: String, enum: ["pending", "verified", "failed"], default: "pending" },
      codeHash: String,
      expiresAt: Date,
      attempts: { type: Number, default: 0 },
      verifiedAt: Date,
    },
    /** Caller ID may only be used for outbound calls once the business has proven it controls the number. */
    callerIdAuthorized: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export const BusinessPhoneNumber = defineModel("BusinessPhoneNumber", numberSchema);

export const SESSION_STATUSES = ["ringing", "answered", "in_progress", "completed", "failed", "no_answer", "busy", "canceled", "abandoned"] as const;
const sessionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", index: true },
    connectionKind: { type: String, enum: CONNECTION_KINDS, required: true },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    providerCallId: { type: String, required: true },
    fromNumber: String,
    toNumber: String,
    status: { type: String, enum: SESSION_STATUSES, default: "ringing" },
    terminationReason: String,
    startedAt: { type: Date, default: () => new Date() },
    answeredAt: Date,
    endedAt: Date,
    durationSeconds: Number,
    dtmf: { type: [String], default: [] },
    /** Gateway-reported media quality (null = not measured). */
    quality: { jitterMs: Number, packetLossPct: Number, rttMs: Number, mos: Number },
    /** Time from end of caller speech to first agent audio, as measured by the voice worker (null = not measured). */
    latency: { turns: { type: Number, default: 0 }, totalMs: { type: Number, default: 0 }, maxMs: { type: Number, default: 0 } },
    isTest: { type: Boolean, default: false },
  },
  { timestamps: true },
);
sessionSchema.index({ connectionKind: 1, providerCallId: 1 }, { unique: true });
sessionSchema.index({ businessId: 1, status: 1 });
export const CallSession = defineModel("CallSession", sessionSchema);

export const OUTBOUND_PURPOSES = ["reservation_reminder", "customer_callback", "order_status", "approved_follow_up"] as const;
export const OUTBOUND_STATUSES = ["pending", "scheduled", "dialing", "completed", "failed", "blocked", "cancelled", "exhausted"] as const;
const outboundSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    /** Caller-supplied key: the same key never creates a second request. */
    idempotencyKey: { type: String, required: true },
    purpose: { type: String, enum: OUTBOUND_PURPOSES, required: true },
    toNumber: { type: String, required: true },
    recipientName: { type: String, default: "" },
    recipientTimezone: { type: String, default: "" },
    callerIdNumber: { type: String, required: true },
    message: { type: String, default: "" },
    reservationId: { type: Schema.Types.ObjectId, ref: "Reservation" },
    followUpId: { type: Schema.Types.ObjectId, ref: "FollowUp" },
    requestedBy: { type: String, default: "" },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: Date,
    status: { type: String, enum: OUTBOUND_STATUSES, default: "pending" },
    blockedReason: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 2, min: 1, max: 5 },
    nextAttemptAt: Date,
    lastError: { type: String, default: "" },
    callId: { type: Schema.Types.ObjectId, ref: "Call" },
    audit: [{ _id: false, at: { type: Date, default: () => new Date() }, event: String, detail: String }],
  },
  { timestamps: true },
);
outboundSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
outboundSchema.index({ status: 1, nextAttemptAt: 1 });
export const OutboundCallRequest = defineModel("OutboundCallRequest", outboundSchema);

const consentSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    phone: { type: String, required: true },
    purpose: { type: String, enum: OUTBOUND_PURPOSES, required: true },
    /** How consent was obtained, e.g. "booking form checkbox 2026-10-01". Required: consent without evidence does not count. */
    evidence: { type: String, required: true },
    grantedAt: { type: Date, default: () => new Date() },
    revokedAt: Date,
  },
  { timestamps: true },
);
consentSchema.index({ businessId: 1, phone: 1, purpose: 1 });
export const OutboundConsent = defineModel("OutboundConsent", consentSchema);

const suppressionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    phone: { type: String, required: true },
    reason: { type: String, enum: ["do_not_call", "opt_out_on_call", "complaint", "manual"], default: "do_not_call" },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);
suppressionSchema.index({ businessId: 1, phone: 1 }, { unique: true });
export const SuppressionEntry = defineModel("SuppressionEntry", suppressionSchema);

const routingRuleSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    name: { type: String, required: true },
    priority: { type: Number, default: 100 },
    enabled: { type: Boolean, default: true },
    match: { numberId: { type: Schema.Types.ObjectId, ref: "BusinessPhoneNumber" }, schedule: { type: String, enum: ["always", "after_hours", "business_hours"], default: "always" } },
    action: { type: String, enum: ["ai_answer", "ring_staff_then_ai", "forward_to_number", "voicemail_callback"], default: "ai_answer" },
    forwardTo: { type: String, default: "" },
  },
  { timestamps: true },
);
export const CallRoutingRule = defineModel("CallRoutingRule", routingRuleSchema);

export const PROVIDER_ROLES = ["stt", "llm", "tts", "voice_agent"] as const;
const providerConfigSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    role: { type: String, enum: PROVIDER_ROLES, required: true },
    /** Ordered: index 0 is primary, the rest are fallbacks. */
    providers: [{ _id: false, id: String, enabled: { type: Boolean, default: true }, timeoutMs: { type: Number, default: 4000 } }],
  },
  { timestamps: true },
);
providerConfigSchema.index({ businessId: 1, role: 1 }, { unique: true });
export const AgentProviderConfig = defineModel("AgentProviderConfig", providerConfigSchema);

const healthSchema = new Schema(
  {
    /** null businessId = platform-wide provider health. */
    businessId: { type: Schema.Types.ObjectId, ref: "Business", index: true },
    provider: { type: String, required: true },
    kind: { type: String, enum: ["check_ok", "check_failed", "breaker_open", "breaker_closed", "heartbeat", "alert"], required: true },
    detail: { type: String, default: "" },
    latencyMs: Number,
    at: { type: Date, default: () => new Date(), expires: 86400 * 30 },
  },
  { versionKey: false },
);
healthSchema.index({ provider: 1, at: -1 });
export const TelephonyHealthEvent = defineModel("TelephonyHealthEvent", healthSchema);

const recoverySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call" },
    sessionId: { type: Schema.Types.ObjectId, ref: "CallSession" },
    callerNumber: String,
    reason: { type: String, required: true },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    /** Unique per session+reason so a retried event cannot create the task twice. */
    key: { type: String, required: true },
    resolvedAt: Date,
  },
  { timestamps: true },
);
recoverySchema.index({ businessId: 1, key: 1 }, { unique: true });
export const CallRecoveryTask = defineModel("CallRecoveryTask", recoverySchema);
