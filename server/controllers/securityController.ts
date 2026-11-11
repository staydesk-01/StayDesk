import { z } from "zod";
import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { AuditLog, Business, LoginEvent, Recording, SipTrunk, TelephonyConnection, User } from "../models";
import { audit } from "../services/auditService";
import { env } from "../config/env";
import { secretsConfigured } from "../utils/secrets";

const day = 24 * 3600_000;
const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, "$1•••$2");

/**
 * Everything on the Security & Privacy page, for ONE business. Each item says where its data comes from; anything the
 * application cannot observe (e.g. database backups) is reported as unknown rather than assumed healthy.
 */
export async function overview(req: Request, res: Response) {
  const a = auth(req);
  const since24 = new Date(Date.now() - day);
  const [biz, users, logins, failed24, locked24, sensitive, recAccess, conns, trunks, recCount] = await Promise.all([
    Business.findById(a.businessId).select("security privacy"),
    User.find({ businessId: a.businessId }).select("name email role active mfa.enabled mfa.enrolledAt createdAt"),
    LoginEvent.find({ businessId: a.businessId }).sort({ createdAt: -1 }).limit(25),
    LoginEvent.countDocuments({ businessId: a.businessId, outcome: { $in: ["bad_password", "mfa_failed"] }, createdAt: { $gte: since24 } }),
    LoginEvent.countDocuments({ businessId: a.businessId, outcome: "locked", createdAt: { $gte: since24 } }),
    AuditLog.find({ businessId: a.businessId, action: /^(transcript|customer|recording\.deleted|auth\.mfa|team\.|call\.deleted|privacy)/ }).sort({ createdAt: -1 }).limit(25),
    AuditLog.find({ businessId: a.businessId, action: /^recording\./ }).sort({ createdAt: -1 }).limit(25),
    TelephonyConnection.find({ businessId: a.businessId }).select("kind status statusReason lastOkAt"),
    SipTrunk.countDocuments({ businessId: a.businessId }),
    Recording.countDocuments({ businessId: a.businessId, status: "available" }),
  ]);
  const staff = users.filter((u) => u.active);
  const privileged = staff.filter((u) => u.role === "owner" || u.role === "admin");
  const withoutMfa = privileged.filter((u) => !u.mfa?.enabled);

  const alerts: { level: "high" | "medium" | "info"; message: string }[] = [];
  if (withoutMfa.length) alerts.push({ level: biz?.security?.requireMfa ? "high" : "medium", message: `${withoutMfa.length} owner/admin account(s) have no two-step sign-in.` });
  if (failed24 >= 5) alerts.push({ level: "high", message: `${failed24} failed sign-in attempts in the last 24 hours.` });
  if (locked24) alerts.push({ level: "medium", message: `${locked24} sign-in attempt(s) were blocked by the lockout in the last 24 hours.` });
  if (!secretsConfigured()) alerts.push({ level: "medium", message: "TELEPHONY_SECRET_KEY is not set: provider credentials and authenticator secrets cannot be stored." });
  if (env.isProd && !env.COOKIE_SECURE) alerts.push({ level: "high", message: "Session cookies are not marked Secure in production." });

  res.json({
    authentication: { method: "Email + password (bcrypt), signed httpOnly session cookie", sessionDays: 7, lockout: "5 failed attempts per email in 15 minutes", cookieSecure: env.COOKIE_SECURE },
    mfa: { available: secretsConfigured(), required: !!biz?.security?.requireMfa, privilegedUsers: privileged.length, enrolled: privileged.length - withoutMfa.length },
    users: users.map((u) => ({ id: String(u._id), name: u.name, email: maskEmail(u.email), role: u.role, active: u.active, mfa: !!u.mfa?.enabled })),
    recentLogins: logins.map((l) => ({ at: l.createdAt, email: maskEmail(l.email), outcome: l.outcome, ip: l.ip })),
    failedLogins24h: failed24,
    sensitiveAccess: sensitive.map((l) => ({ at: l.createdAt, action: l.action, actor: l.actorId, entity: l.entity })),
    recordingAccess: recAccess.map((l) => ({ at: l.createdAt, action: l.action, actor: l.actorId, recording: l.entityId })),
    alerts,
    alertsNote: "Alerts are derived from stored login and audit events. API rate-limit blocks are enforced but not yet stored, so they do not appear here.",
    backups: { status: "unknown", note: "TrulyHello cannot see your MongoDB backups. Enable and test backups with your database host (e.g. Atlas continuous backup) and record the last restore test with your own records." },
    retention: { transcriptDays: biz?.privacy?.transcriptRetentionDays ?? 90, recordingDays: biz?.privacy?.recordingRetentionDays ?? 90, recordingsStored: recCount, recordingEnabled: !!biz?.privacy?.recordingEnabled },
    permissions: { staffCanListen: !!biz?.security?.staffCanListen, staffCanSeePhone: !!biz?.security?.staffCanSeePhone },
    integrations: [
      ...conns.map((c) => ({ name: c.kind, status: c.status, detail: c.statusReason ?? "" })),
      { name: "twilio (legacy webhook calling)", status: env.TWILIO_AUTH_TOKEN ? "configured" : "not_configured", detail: "Webhooks are verified with Twilio's request signature." },
      { name: "sip trunks", status: trunks ? "configured" : "not_configured", detail: `${trunks} trunk(s)` },
    ],
    encryption: { inTransit: "TLS is provided by your hosting (Vercel/Railway/etc.); this app does not terminate TLS.", atRest: "Provider credentials and authenticator secrets are AES-256-GCM encrypted by the app. Database-level encryption at rest and backup encryption depend on your MongoDB host and are not verified here." },
  });
}

const settings = z.object({
  requireMfa: z.boolean().optional(),
  staffCanListen: z.boolean().optional(),
  staffCanSeePhone: z.boolean().optional(),
  recordingRetentionDays: z.number().int().min(1).max(3650).optional(),
});
export async function updateSettings(req: Request, res: Response) {
  const a = auth(req);
  const b = settings.parse(req.body);
  const $set: Record<string, unknown> = {};
  for (const k of ["requireMfa", "staffCanListen", "staffCanSeePhone"] as const) if (b[k] !== undefined) $set[`security.${k}`] = b[k];
  if (b.recordingRetentionDays !== undefined) $set["privacy.recordingRetentionDays"] = b.recordingRetentionDays;
  await Business.updateOne({ _id: a.businessId }, { $set });
  await audit(req, a.businessId, "privacy.settings_changed", "business", a.businessId, b);
  res.json({ ok: true });
}
