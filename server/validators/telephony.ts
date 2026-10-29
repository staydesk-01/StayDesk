import net from "node:net";
import { z } from "zod";
import { CONNECTION_KINDS, NUMBER_MODES, OUTBOUND_PURPOSES } from "../models";

const t = (max: number) => z.string().trim().max(max);

export const connectionBody = z.object({
  kind: z.enum(CONNECTION_KINDS),
  label: t(80).optional(),
  /** Non-secret settings only. Unknown keys are dropped. */
  settings: z.record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean()])).default({}),
  /** Credentials by name. Encrypted at rest; omit a key to keep the stored value. */
  secrets: z.record(z.string().max(40), z.string().min(1).max(500)).default({}),
});

export const numberBody = z.object({
  number: t(32).min(5),
  mode: z.enum(NUMBER_MODES).default("forwarding"),
  role: z.enum(["inbound", "outbound_caller_id", "both"]).default("inbound"),
  answerMode: z.enum(["all_calls", "overflow"]).default("overflow"),
});
export const verifyBody = z.object({ code: t(12).regex(/^\d{6}$/, "Enter the 6-digit code") });

export const trunkBody = z.object({
  name: t(60).min(1),
  host: t(200).regex(/^[A-Za-z0-9.-]+(:\d{2,5})?$/, "Use a host name or IP, optionally with :port"),
  transport: z.enum(["tls", "tcp", "udp"]).default("tls"),
  srtp: z.boolean().default(true),
  direction: z.enum(["inbound", "outbound", "both"]).default("both"),
  allowedIps: z.array(t(45).refine((ip) => net.isIP(ip) !== 0, "Not a valid IP address")).max(50).default([]),
  authUsername: t(120).default(""),
  authPassword: t(200).optional(),
  maxConcurrentCalls: z.coerce.number().int().min(1).max(1000).default(10),
});

export const outboundRequestBody = z.object({
  idempotencyKey: t(120).min(8),
  purpose: z.enum(OUTBOUND_PURPOSES),
  toNumber: t(32).min(5),
  callerIdNumber: t(32).min(5),
  recipientName: t(120).optional(),
  recipientTimezone: t(60).optional(),
  message: t(500).optional(),
  reservationId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  followUpId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
});

export const consentBody = z.object({ phone: t(32).min(5), purpose: z.enum(OUTBOUND_PURPOSES), evidence: t(300).min(5, "Describe how consent was given") });
export const suppressionBody = z.object({ phone: t(32).min(5), note: t(200).optional() });
export const outboundSettingsBody = z.object({
  enabled: z.boolean().optional(),
  purposes: z.array(z.enum(OUTBOUND_PURPOSES)).optional(),
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  maxAttempts: z.coerce.number().int().min(1).max(5).optional(),
  retryMinutes: z.coerce.number().int().min(15).max(1440).optional(),
  jurisdictionNote: t(300).optional(),
});
