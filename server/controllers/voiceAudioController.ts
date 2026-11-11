import type { Request, Response } from "../http";
import { VoiceClip } from "../models";
import { verifyClipSignature } from "../services/voice/tts";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";

/**
 * Public, but only with a valid signature that expires after 15 minutes. Twilio fetches this to play a reply.
 * Anything wrong (bad signature, expired, unknown clip) is the same 404 so nothing is revealed.
 */
export async function streamClip(req: Request, res: Response) {
  const id = String(req.params.id ?? "");
  if (!verifyClipSignature(id, Number(req.query.exp), String(req.query.sig ?? ""))) throw AppError.notFound();
  const clip = await VoiceClip.findOne({ _id: toObjectId(id), expiresAt: { $gt: new Date() } }).select("+audio contentType");
  if (!clip) throw AppError.notFound();
  res.sendBinary(clip.audio, clip.contentType || "audio/mpeg");
}
