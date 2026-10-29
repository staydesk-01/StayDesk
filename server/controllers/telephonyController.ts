import type { Request, Response } from "../http";
import { flags } from "../config/flags";
import { auth } from "../middleware/auth";
import {
  Business, BusinessPhoneNumber, CallRecoveryTask, CallSession, OutboundCallRequest, OutboundConsent, SipTrunk, SuppressionEntry, TelephonyConnection, TelephonyHealthEvent,
} from "../models";
import { audit } from "../services/auditService";
import { dispatchDue, cancelOutbound, requestOutbound } from "../services/outbound/service";
import { getAdapter } from "../services/telephony/core/registry";
import { reapStaleSessions } from "../services/telephony/core/sessions";
import { checkConnection, effectiveStatus } from "../services/telephony/core/health";
import { addNumber, verifyNumber } from "../services/telephony/core/numbers";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";
import { normalizePhone } from "../utils/phone";
import { encryptSecret, maskSecret, secretsConfigured } from "../utils/secrets";
import { connectionBody, consentBody, numberBody, outboundRequestBody, outboundSettingsBody, suppressionBody, trunkBody, verifyBody } from "../validators/telephony";
import { CONNECTION_KINDS } from "../models";
import { secureEqual } from "../utils/secureEqual";

const requireCore = () => { if (!flags.telephonyCore()) throw AppError.notFound("Telephony core is not enabled"); };

/** Everything the Telephony page shows. Never includes secrets, only masks. */
export async function overview(req: Request, res: Response) {
  const { businessId } = auth(req);
  const enabled = flags.telephonyCore();
  const f = { telephonyCore: enabled, sipGateway: flags.sipGateway(), outboundCalling: flags.outboundCalling(), secretsConfigured: secretsConfigured() };
  if (!enabled) return void res.json({ flags: f, enabled: false });

  const since = new Date(Date.now() - 24 * 3600_000);
  const [connections, numbers, trunks, active, recent, health, outbound, recovery, business] = await Promise.all([
    TelephonyConnection.find({ businessId }),
    BusinessPhoneNumber.find({ businessId }).select("-verification.codeHash"),
    SipTrunk.find({ businessId }).select("-authPassword.cipher"),
    CallSession.find({ businessId, status: { $in: ["ringing", "answered", "in_progress"] } }).sort({ startedAt: -1 }).limit(50),
    CallSession.find({ businessId, startedAt: { $gte: since } }),
    TelephonyHealthEvent.find({ $or: [{ businessId }, { businessId: null }] }).sort({ at: -1 }).limit(30),
    OutboundCallRequest.find({ businessId }).sort({ createdAt: -1 }).limit(30),
    CallRecoveryTask.countDocuments({ businessId, status: "open" }),
    Business.findById(businessId).select("outbound"),
  ]);
  const measured = recent.filter((s) => s.latency && s.latency.turns > 0);
  const withQuality = recent.filter((s) => s.quality && (s.quality.jitterMs != null || s.quality.packetLossPct != null || s.quality.mos != null));
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  res.json({
    flags: f,
    enabled: true,
    connections: connections.map((c) => ({
      id: c._id, kind: c.kind, label: c.label, ...effectiveStatus(c), lastCheckedAt: c.lastCheckedAt, lastOkAt: c.lastOkAt, settings: c.settings,
      secrets: Object.fromEntries([...(c.secrets as Map<string, { mask?: string }>).entries()].map(([k, v]) => [k, v.mask ?? "••••"])),
      capabilities: getAdapter(c.kind).capabilities,
    })),
    available: CONNECTION_KINDS.map((k) => ({ kind: k, capabilities: getAdapter(k).capabilities })),
    numbers, trunks, activeCalls: active, outbound, outboundSettings: business?.outbound, openRecoveryTasks: recovery,
    health,
    quality: {
      sessions24h: recent.length,
      latencyMeasuredCalls: measured.length,
      avgTurnLatencyMs: measured.length ? Math.round(measured.reduce((a, s) => a + s.latency!.totalMs, 0) / measured.reduce((a, s) => a + s.latency!.turns, 0)) : null,
      maxTurnLatencyMs: measured.length ? Math.max(...measured.map((s) => s.latency!.maxMs)) : null,
      qualityMeasuredCalls: withQuality.length,
      avgJitterMs: avg(withQuality.map((s) => s.quality!.jitterMs).filter((x): x is number => x != null)),
      avgPacketLossPct: avg(withQuality.map((s) => s.quality!.packetLossPct).filter((x): x is number => x != null)),
      avgMos: avg(withQuality.map((s) => s.quality!.mos).filter((x): x is number => x != null)),
    },
  });
}

export async function saveConnection(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const body = connectionBody.parse(req.body);
  const existing = await TelephonyConnection.findOne({ businessId: a.businessId, kind: body.kind });
  const secrets = new Map((existing?.secrets as Map<string, { cipher: string; mask: string }> | undefined) ?? []);
  if (Object.keys(body.secrets).length) {
    if (!secretsConfigured()) throw AppError.badRequest("The server has no TELEPHONY_SECRET_KEY, so credentials cannot be stored safely yet.");
    for (const [name, value] of Object.entries(body.secrets)) secrets.set(name, { cipher: encryptSecret(value), mask: maskSecret(value) });
  }
  const conn = await TelephonyConnection.findOneAndUpdate(
    { businessId: a.businessId, kind: body.kind },
    { $set: { label: body.label ?? existing?.label ?? "", settings: body.settings, secrets, status: "testing", statusReason: "Saved. Run a test to check the connection." }, $setOnInsert: { businessId: a.businessId, kind: body.kind } },
    { upsert: true, returnDocument: "after" },
  );
  await audit(req, a.businessId, "telephony.connection.save", "telephonyConnection", conn!._id, { kind: body.kind, secretNames: Object.keys(body.secrets) });
  res.status(201).json({ id: conn!._id, kind: conn!.kind, status: conn!.status });
}

export async function testConnection(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const kind = String(req.params.kind);
  if (!(CONNECTION_KINDS as readonly string[]).includes(kind)) throw AppError.notFound("Unknown connection type");
  const result = await checkConnection(a.businessId, kind as (typeof CONNECTION_KINDS)[number]);
  await audit(req, a.businessId, "telephony.connection.test", "telephonyConnection", a.businessId, { kind, status: result.status });
  res.json(result);
}

export async function addPhoneNumber(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const body = numberBody.parse(req.body);
  const r = await addNumber({ businessId: a.businessId, number: body.number, mode: body.mode, role: body.role, answerMode: body.answerMode });
  await audit(req, a.businessId, "telephony.number.add", "businessPhoneNumber", r.id, { mode: body.mode });
  // The code is never returned: it was sent to the number itself (or not sent at all: see `delivery`).
  res.status(201).json({ id: r.id, delivery: r.delivery, next: r.delivery === "sent" ? "Enter the code that was sent to that number." : "The code could not be sent automatically (no SMS provider configured). The number stays unverified until it is." });
}

export async function verifyPhoneNumber(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const { code } = verifyBody.parse(req.body);
  const ok = await verifyNumber(a.businessId, String(req.params.id), code);
  await audit(req, a.businessId, "telephony.number.verify", "businessPhoneNumber", String(req.params.id), { ok });
  if (!ok) throw AppError.badRequest("That code is not correct.");
  res.json({ verified: true });
}

export async function removePhoneNumber(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const r = await BusinessPhoneNumber.deleteOne({ _id: toObjectId(String(req.params.id)), businessId: a.businessId });
  if (!r.deletedCount) throw AppError.notFound("Number not found");
  await audit(req, a.businessId, "telephony.number.remove", "businessPhoneNumber", String(req.params.id));
  res.json({ ok: true });
}

export async function saveTrunk(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const b = trunkBody.parse(req.body);
  if (b.transport !== "tls" && !b.srtp) throw AppError.badRequest("Unencrypted signalling and media are not allowed together. Use TLS or enable SRTP.");
  const set: Record<string, unknown> = { name: b.name, host: b.host, transport: b.transport, srtp: b.srtp, direction: b.direction, allowedIps: b.allowedIps, authUsername: b.authUsername, maxConcurrentCalls: b.maxConcurrentCalls };
  if (b.authPassword) {
    if (!secretsConfigured()) throw AppError.badRequest("The server has no TELEPHONY_SECRET_KEY, so credentials cannot be stored safely yet.");
    set.authPassword = { cipher: encryptSecret(b.authPassword), mask: maskSecret(b.authPassword) };
  }
  const trunk = await SipTrunk.findOneAndUpdate({ businessId: a.businessId, name: b.name }, { $set: set, $setOnInsert: { businessId: a.businessId, status: "not_configured" } }, { upsert: true, returnDocument: "after" });
  await audit(req, a.businessId, "telephony.trunk.save", "sipTrunk", trunk!._id, { host: b.host, transport: b.transport, allowedIps: b.allowedIps.length });
  res.status(201).json({ id: trunk!._id });
}

// ---------------------------------------------------------------- outbound ----------------------------------------------------
const requireOutbound = () => { requireCore(); if (!flags.outboundCalling()) throw AppError.notFound("Outbound calling is not enabled"); };

export async function saveOutboundSettings(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const b = outboundSettingsBody.parse(req.body);
  const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined).map(([k, v]) => [`outbound.${k}`, v]));
  const business = await Business.findByIdAndUpdate(a.businessId, { $set: set }, { returnDocument: "after" }).select("outbound");
  await audit(req, a.businessId, "outbound.settings", "business", a.businessId, b);
  res.json({ outbound: business?.outbound });
}

export async function createOutbound(req: Request, res: Response) {
  requireOutbound();
  const a = auth(req);
  const b = outboundRequestBody.parse(req.body);
  const r = await requestOutbound({
    businessId: a.businessId, idempotencyKey: b.idempotencyKey, purpose: b.purpose, toNumber: b.toNumber, callerIdNumber: b.callerIdNumber, recipientName: b.recipientName,
    recipientTimezone: b.recipientTimezone, message: b.message, requestedBy: a.email,
    reservationId: b.reservationId ? toObjectId(b.reservationId) : undefined, followUpId: b.followUpId ? toObjectId(b.followUpId) : undefined,
    approvedBy: b.purpose === "approved_follow_up" ? toObjectId(a.userId) : undefined,
  });
  await audit(req, a.businessId, "outbound.request", "outboundCallRequest", r.request._id, { purpose: b.purpose, status: r.request.status, duplicate: r.duplicate });
  res.status(r.duplicate ? 200 : 201).json({ request: r.request, duplicate: r.duplicate });
}

export async function listOutbound(req: Request, res: Response) {
  requireCore();
  const { businessId } = auth(req);
  const [requests, consents, suppressed] = await Promise.all([
    OutboundCallRequest.find({ businessId }).sort({ createdAt: -1 }).limit(100),
    OutboundConsent.find({ businessId, revokedAt: { $exists: false } }).sort({ createdAt: -1 }).limit(100),
    SuppressionEntry.find({ businessId }).sort({ createdAt: -1 }).limit(100),
  ]);
  res.json({ requests, consents, suppressed });
}

export async function cancelOutboundRequest(req: Request, res: Response) {
  requireOutbound();
  const a = auth(req);
  const r = await cancelOutbound(a.businessId, String(req.params.id), a.email);
  await audit(req, a.businessId, "outbound.cancel", "outboundCallRequest", r._id);
  res.json({ request: r });
}

export async function addConsent(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const b = consentBody.parse(req.body);
  const phone = normalizePhone(b.phone);
  if (await SuppressionEntry.exists({ businessId: a.businessId, phone })) throw AppError.conflict("That number is on the do-not-call list. Remove it from the list first, only if the person has asked you to.");
  const c = await OutboundConsent.create({ businessId: a.businessId, phone, purpose: b.purpose, evidence: b.evidence });
  await audit(req, a.businessId, "outbound.consent.add", "outboundConsent", c._id, { purpose: b.purpose });
  res.status(201).json({ consent: c });
}

export async function revokeConsent(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const r = await OutboundConsent.updateOne({ _id: toObjectId(String(req.params.id)), businessId: a.businessId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
  if (!r.matchedCount) throw AppError.notFound("Consent record not found");
  await audit(req, a.businessId, "outbound.consent.revoke", "outboundConsent", String(req.params.id));
  res.json({ ok: true });
}

export async function addSuppression(req: Request, res: Response) {
  requireCore();
  const a = auth(req);
  const b = suppressionBody.parse(req.body);
  const phone = normalizePhone(b.phone);
  await SuppressionEntry.updateOne({ businessId: a.businessId, phone }, { $setOnInsert: { businessId: a.businessId, phone, reason: "do_not_call", note: b.note ?? "" } }, { upsert: true });
  await OutboundCallRequest.updateMany({ businessId: a.businessId, toNumber: phone, status: { $in: ["pending", "scheduled"] } }, { $set: { status: "cancelled", blockedReason: "Added to the do-not-call list" } });
  await audit(req, a.businessId, "outbound.dnc.add", "suppressionEntry", phone);
  res.status(201).json({ ok: true });
}

/** Scheduler entry point: POST with `Authorization: Bearer $CRON_SECRET` (a cron job, GitHub Action or platform scheduler). */
export async function dispatch(req: Request, res: Response) {
  if (!flags.telephonyCore() || !flags.outboundCalling()) throw AppError.notFound("Not found");
  const secret = process.env.CRON_SECRET;
  const given = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || secret.length < 24 || !secureEqual(given, secret)) throw AppError.unauthorized("Invalid scheduler credentials");
  const reaped = await reapStaleSessions();
  res.json({ results: await dispatchDue(), reapedSessions: reaped });
}

