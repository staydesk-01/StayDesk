import crypto from "node:crypto";
import type { Types } from "mongoose";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { Business, Call, Recording } from "../../models";
import { audit } from "../auditService";
import { secureEqual } from "../../utils/secureEqual";

/** Playback links last this long. They are bound to one signed-in user, so a copied link is useless to anyone else. */
export const LINK_TTL_MS = () => Number(process.env.RECORDING_LINK_TTL_MS) || 5 * 60_000;
const secret = () => process.env.JWT_SECRET ?? env.JWT_SECRET ?? "";

export type Purpose = "play" | "download";

export function signLink(recordingId: string, userId: string, purpose: Purpose, now = Date.now()) {
  const exp = now + LINK_TTL_MS();
  const body = `${recordingId}.${userId}.${purpose}.${exp}`;
  const sig = crypto.createHmac("sha256", secret()).update(`rec:${body}`).digest("base64url");
  return { token: `${Buffer.from(body).toString("base64url")}.${sig}`, expiresAt: new Date(exp) };
}

export function verifyLink(token: string, now = Date.now()): { recordingId: string; userId: string; purpose: Purpose } | null {
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  let body: string;
  try { body = Buffer.from(b64, "base64url").toString(); } catch { return null; }
  const expected = crypto.createHmac("sha256", secret()).update(`rec:${body}`).digest("base64url");
  if (!secureEqual(sig, expected)) return null;
  const [recordingId, userId, purpose, exp] = body.split(".");
  if (!recordingId || !userId || (purpose !== "play" && purpose !== "download") || Number(exp) < now) return null;
  return { recordingId, userId, purpose };
}

/** Provider recordings are only ever fetched from Twilio's API host, never from a URL a request could influence. */
const allowedHost = (url: string) => { try { return new URL(url).hostname === "api.twilio.com"; } catch { return false; } };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (u, i) => fetch(u, i);
export const __setRecordingFetchForTest = (f: Fetch | null) => { fetchImpl = f ?? ((u, i) => fetch(u, i)); };

const basicAuth = () => `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID ?? ""}:${env.TWILIO_AUTH_TOKEN ?? ""}`).toString("base64")}`;

/** Called when the provider says a recording is ready. Idempotent: a re-delivered webhook returns the same record. */
export async function registerRecording(p: { callSid: string; url?: string; sid?: string; duration?: number }) {
  const call = await Call.findOne({ provider: "twilio", providerCallId: p.callSid });
  if (!call) return null;
  const business = await Business.findById(call.businessId).select("privacy");
  // Never keep a recording for a business that has not enabled recording.
  if (!business?.privacy?.recordingEnabled) return null;
  if (p.url && !allowedHost(p.url)) { logger.warn("Ignoring recording from an unexpected host"); return null; }
  const days = business.privacy.recordingRetentionDays ?? 90;
  const filter = { businessId: call.businessId, providerRecordingId: p.sid ?? p.callSid };
  const rec = await Recording.findOneAndUpdate(
    filter,
    { $setOnInsert: { callId: call._id, callUuid: call.callUuid, provider: "twilio", storage: { kind: "provider_reference", ref: p.url }, durationSeconds: p.duration, consentAnnounced: !!business.privacy.recordingConsentMessage, retentionUntil: new Date(Date.now() + days * 86400_000) } },
    { upsert: true, returnDocument: "after" },
  );
  await Call.updateOne({ _id: call._id }, { $set: { "recording.enabled": true, "recording.sid": p.sid, "recording.durationSeconds": p.duration, "recording.recordingId": rec.recordingId } });
  return rec;
}

export async function loadAudio(recordingId: string, businessId: Types.ObjectId): Promise<{ bytes: Uint8Array; type: string } | null> {
  const rec = await Recording.findOne({ recordingId, businessId, status: "available" }).select("+storage.ref");
  const ref = rec?.storage?.ref;
  if (!rec || !ref || !allowedHost(ref)) return null;
  const res = await fetchImpl(ref.endsWith(".mp3") ? ref : `${ref}.mp3`, { headers: { authorization: basicAuth() } });
  if (!res.ok) return null;
  return { bytes: new Uint8Array(await res.arrayBuffer()), type: "audio/mpeg" };
}

/** Marks the recording deleted and asks the provider to delete its copy. The outcome of that request is recorded honestly. */
export async function deleteRecording(rec: InstanceType<typeof Recording>, by: string, req: Parameters<typeof audit>[0], reason: string) {
  const full = await Recording.findById(rec._id).select("+storage.ref");
  let providerDeletion = "not_attempted";
  const ref = full?.storage?.ref;
  if (ref && allowedHost(ref) && env.TWILIO_ACCOUNT_SID) {
    try { const r = await fetchImpl(ref, { method: "DELETE", headers: { authorization: basicAuth() } }); providerDeletion = r.ok || r.status === 404 ? "deleted" : "failed"; } catch { providerDeletion = "failed"; }
  }
  await Recording.updateOne({ _id: rec._id }, { $set: { status: "deleted", deletedAt: new Date(), deletedBy: by, providerDeletion }, $unset: { "storage.ref": 1 } });
  await Call.updateOne({ _id: rec.callId }, { $set: { "recording.enabled": false }, $unset: { "recording.url": 1 } });
  await audit(req, rec.businessId, "recording.deleted", "recording", rec.recordingId, { reason, providerDeletion }, by === "system" ? { type: "system" } : undefined);
  return providerDeletion;
}

/** Retention: delete recordings past their window. Run from the existing periodic job. */
export async function purgeExpiredRecordings(now = new Date()) {
  const expired = await Recording.find({ status: "available", retentionUntil: { $lt: now } }).limit(200);
  for (const r of expired) await deleteRecording(r, "system", null, "retention_expired").catch((e) => logger.error("Recording purge failed", { message: (e as Error).message }));
  return expired.length;
}

export const maskPhone = (p: string | undefined | null) => (p ? `${p.slice(0, 2)}••• ••• ${p.slice(-4)}` : "");
