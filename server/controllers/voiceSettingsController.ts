import type { Request, Response } from "../http";
import { env } from "../config/env";
import { auth } from "../middleware/auth";
import { Business } from "../models";
import { synthesizePreview, ttsEnabled } from "../services/voice/tts";
import { VOICE_CATALOG, findCatalogVoice, resolveVoiceId, type VoiceGender } from "../services/voice/voices";
import { AppError } from "../utils/errors";
import { z } from "zod";

const previewBody = z.object({ gender: z.enum(["female", "male"]).optional(), voiceId: z.string().max(60).optional() });

/** Each preview costs ElevenLabs characters, so they are limited per business (in memory, per instance). */
const PREVIEW_LIMIT = 20;
const PREVIEW_WINDOW_MS = 60 * 60_000;
const previews = new Map<string, { count: number; reset: number }>();
function takePreview(businessId: string) {
  const now = Date.now();
  const e = previews.get(businessId);
  if (!e || e.reset < now) {
    previews.set(businessId, { count: 1, reset: now + PREVIEW_WINDOW_MS });
    return;
  }
  if (++e.count > PREVIEW_LIMIT) throw new AppError(429, "Too many voice previews. Try again in a little while.", "rate_limited");
}
export const __resetPreviewLimitForTest = () => previews.clear();

export async function getVoiceSettings(req: Request, res: Response) {
  const business = await Business.findById(auth(req).businessId).select("voice");
  if (!business) throw AppError.notFound("Business not found");
  const gender: VoiceGender = business.voice?.gender === "male" ? "male" : "female";
  res.json({
    elevenlabs: { configured: ttsEnabled(), model: env.ELEVENLABS_MODEL },
    voices: VOICE_CATALOG,
    voice: { provider: business.voice?.provider ?? "elevenlabs", gender, voiceId: resolveVoiceId(gender, business.voice?.voiceId) },
  });
}

/** Plays a short sample of a voice. The sentence is fixed (not free text) so this can't be used as a general text-to-speech service. */
export async function previewVoice(req: Request, res: Response) {
  const a = auth(req);
  const body = previewBody.parse(req.body ?? {});
  if (!ttsEnabled()) throw new AppError(503, "ElevenLabs is not set up on this server yet. Add ELEVENLABS_API_KEY and restart.", "voice_unavailable");
  if (body.voiceId && !findCatalogVoice(body.voiceId)) throw AppError.badRequest("Unknown voice");
  const business = await Business.findById(a.businessId).select("name agentName voice");
  if (!business) throw AppError.notFound("Business not found");
  takePreview(String(a.businessId));

  const gender: VoiceGender = findCatalogVoice(body.voiceId)?.gender ?? body.gender ?? (business.voice?.gender === "male" ? "male" : "female");
  const text = `Hi, thanks for calling ${business.name}. I'm ${business.agentName}, an AI assistant. How can I help you today?`;
  try {
    const { audio, contentType } = await synthesizePreview(text, gender, body.voiceId);
    res.sendBinary(audio, contentType);
  } catch {
    throw new AppError(502, "ElevenLabs could not create the preview. Check the API key and try again.", "voice_failed");
  }
}
