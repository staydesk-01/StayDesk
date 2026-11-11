import { z } from "zod";
import type { QueryFilter } from "mongoose";
import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { Business, Call, CallTranscript, Recording } from "../models";
import { audit, auditRequired } from "../services/auditService";
import { deleteRecording, loadAudio, maskPhone, signLink, verifyLink } from "../services/recordings/recordingService";
import { AppError } from "../utils/errors";
import { normalizePhone } from "../utils/phone";

/** Owners and admins always; staff only if the owner allowed it. */
async function perms(req: Request) {
  const a = auth(req);
  const biz = await Business.findById(a.businessId).select("security");
  const privileged = a.role === "owner" || a.role === "admin";
  return { a, listen: privileged || !!biz?.security?.staffCanListen, phone: privileged || !!biz?.security?.staffCanSeePhone, privileged };
}

const query = z.object({
  q: z.string().trim().max(80).optional(),
  filter: z.enum(["all", "completed", "missed", "transferred", "failed", "flagged"]).default("all"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listRecordings(req: Request, res: Response) {
  const { a, phone, listen } = await perms(req);
  const q = query.parse(req.query);
  const callWhere: QueryFilter<Record<string, unknown>> = { businessId: a.businessId };
  if (q.from || q.to) callWhere.startedAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  if (q.filter === "completed") callWhere.status = "completed";
  if (q.filter === "missed") callWhere.status = "abandoned";
  if (q.filter === "failed") callWhere.status = "failed";
  if (q.filter === "transferred") callWhere.transferStatus = { $ne: "none" };

  const where: QueryFilter<Record<string, unknown>> = { businessId: a.businessId };
  if (q.filter === "flagged") where.flagged = true;
  const text = q.q ?? "";
  if (text) {
    if (UUID.test(text)) where.$or = [{ recordingId: text.toLowerCase() }, { callUuid: text.toLowerCase() }];
    else if (/^[+\d][\d\s().-]{4,}$/.test(text)) {
      // Searching by phone number reveals who called, so it needs the same permission as seeing the number.
      if (!phone) throw AppError.forbidden("You do not have permission to search by phone number");
      callWhere.callerNumber = normalizePhone(text);
    } else throw AppError.badRequest("Search by Call ID, Recording ID or a phone number", "bad_search");
  }
  const needCallFilter = q.from || q.to || q.filter !== "all" && q.filter !== "flagged" || callWhere.callerNumber;
  if (needCallFilter) where.callId = { $in: (await Call.find(callWhere).select("_id").limit(5000)).map((c) => c._id) };

  const recs = await Recording.find(where).sort({ createdAt: -1 }).limit(q.limit);
  const calls = new Map((await Call.find({ _id: { $in: recs.map((r) => r.callId) }, businessId: a.businessId }).select("callerNumber callerName startedAt endedAt durationSeconds status transferStatus outcome direction")).map((c) => [String(c._id), c]));
  res.json({
    canListen: listen,
    recordings: recs.map((r) => {
      const c = calls.get(String(r.callId));
      return {
        recordingId: r.recordingId, callUuid: r.callUuid, callId: String(r.callId), status: r.status, flagged: r.flagged, flagReason: r.flagReason,
        durationSeconds: r.durationSeconds, createdAt: r.createdAt, retentionUntil: r.retentionUntil, consentAnnounced: r.consentAnnounced,
        call: c && { startedAt: c.startedAt, endedAt: c.endedAt, status: c.status, transferStatus: c.transferStatus, outcome: c.outcome, direction: c.direction, callerNumber: phone ? c.callerNumber : maskPhone(c.callerNumber), callerName: phone ? c.callerName : "" },
      };
    }),
  });
}

async function mine(req: Request) {
  const p = await perms(req);
  const id = String(req.params.id);
  const rec = await Recording.findOne({ recordingId: id, businessId: p.a.businessId }); // tenant-scoped: another business's id looks like "not found"
  if (!rec) throw AppError.notFound("Recording not found");
  return { ...p, rec };
}

export async function getRecording(req: Request, res: Response) {
  const { a, rec, listen, phone } = await mine(req);
  const [call, transcript] = await Promise.all([
    Call.findOne({ _id: rec.callId, businessId: a.businessId }).select("callerNumber callerName startedAt endedAt status transferStatus outcome"),
    CallTranscript.findOne({ callId: rec.callId, businessId: a.businessId }),
  ]);
  if (listen && transcript) await auditRequired(req, a.businessId, "transcript.viewed", "recording", rec.recordingId);
  res.json({
    recording: { recordingId: rec.recordingId, callUuid: rec.callUuid, status: rec.status, flagged: rec.flagged, durationSeconds: rec.durationSeconds, createdAt: rec.createdAt, retentionUntil: rec.retentionUntil, consentAnnounced: rec.consentAnnounced, providerDeletion: rec.providerDeletion },
    call: call && { startedAt: call.startedAt, status: call.status, outcome: call.outcome, callerNumber: phone ? call.callerNumber : maskPhone(call.callerNumber) },
    transcriptStatus: transcript ? "available" : "none",
    transcript: listen && transcript ? transcript.segments : undefined,
    canListen: listen,
  });
}

/** Step 1 of playback: an authorised, audited request for a short-lived link. */
export async function issueLink(req: Request, res: Response) {
  const { a, rec, listen } = await mine(req);
  if (!listen) throw AppError.forbidden("You do not have permission to listen to recordings");
  if (rec.status !== "available") throw AppError.notFound("This recording has been deleted");
  const { purpose } = z.object({ purpose: z.enum(["play", "download"]).default("play") }).parse(req.body ?? {});
  const link = signLink(rec.recordingId, a.userId, purpose);
  await auditRequired(req, a.businessId, "recording.link_issued", "recording", rec.recordingId, { purpose });
  res.json({ url: `/api/recordings/${rec.recordingId}/audio?token=${link.token}`, expiresAt: link.expiresAt });
}

/** Step 2: the link only works for the same signed-in user, inside the same business, before it expires. The access is logged before any audio is sent. */
export async function streamAudio(req: Request, res: Response) {
  const { a, rec, listen } = await mine(req);
  const tok = verifyLink(String(req.query.token ?? ""));
  if (!tok || tok.recordingId !== rec.recordingId || tok.userId !== a.userId) throw AppError.forbidden("This link is invalid or has expired");
  if (!listen) throw AppError.forbidden("You do not have permission to listen to recordings");
  if (rec.status !== "available") throw AppError.notFound("This recording has been deleted");
  const audio = await loadAudio(rec.recordingId, a.businessId);
  if (!audio) throw new AppError(502, "The recording could not be retrieved from the provider right now.", "provider_unavailable");
  await auditRequired(req, a.businessId, tok.purpose === "download" ? "recording.downloaded" : "recording.played", "recording", rec.recordingId);

  const size = audio.bytes.byteLength;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.header("range") ?? "");
  const disposition: Record<string, string> = tok.purpose === "download" ? { "content-disposition": `attachment; filename="recording-${rec.recordingId}.mp3"` } : {};
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) throw new AppError(416, "Range not satisfiable", "bad_range");
    res.status(206).sendBinary(audio.bytes.slice(start, end + 1), audio.type, { ...disposition, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
    return;
  }
  res.sendBinary(audio.bytes, audio.type, { ...disposition, "accept-ranges": "bytes" });
}

export async function flagRecording(req: Request, res: Response) {
  const { a, rec } = await mine(req);
  const b = z.object({ flagged: z.boolean(), reason: z.string().trim().max(300).optional() }).parse(req.body);
  await Recording.updateOne({ _id: rec._id }, { $set: { flagged: b.flagged, flagReason: b.flagged ? b.reason ?? "" : "" } });
  await audit(req, a.businessId, b.flagged ? "recording.flagged" : "recording.unflagged", "recording", rec.recordingId, { reason: b.reason });
  res.json({ ok: true });
}

export async function removeRecording(req: Request, res: Response) {
  const { a, rec } = await mine(req);
  if (a.role !== "owner") throw AppError.forbidden("Only the owner can delete recordings");
  if (rec.status === "deleted") return void res.json({ ok: true, providerDeletion: rec.providerDeletion });
  const providerDeletion = await deleteRecording(rec, a.userId, req, "manual");
  res.json({ ok: true, providerDeletion });
}
