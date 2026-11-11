import crypto from "node:crypto";
import type { Types } from "mongoose";
import { env } from "../../config/env";
import { flags } from "../../config/flags";
import { logger } from "../../config/logger";
import { VoiceClip } from "../../models";
import { secureEqual } from "../../utils/secureEqual";
import { resolveVoiceId, type VoiceGender } from "./voices";

/**
 * ElevenLabs text-to-speech for phone calls (Option A: Twilio still listens, ElevenLabs speaks).
 *
 * Every AI reply is turned into an MP3, stored briefly, and handed to Twilio as a signed URL for <Play>.
 * It must never make a call worse: a slow or failing ElevenLabs means the caller hears the standard
 * Polly voice instead (the caller of speakText() gets `null` and keeps using <Say>).
 */

export interface TtsClient {
  synthesize(p: { text: string; voiceId: string; model: string; signal: AbortSignal }): Promise<{ audio: Uint8Array; contentType: string }>;
}

/** Real client. The API key is read here only and is never logged or returned to a browser. */
export const elevenLabsClient: TtsClient = {
  async synthesize({ text, voiceId, model, signal }) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_22050_32`, {
      method: "POST",
      signal,
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY ?? "", "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model }),
    });
    if (!res.ok) throw new Error(`ElevenLabs responded ${res.status}`);
    return { audio: new Uint8Array(await res.arrayBuffer()), contentType: "audio/mpeg" };
  },
};

let override: TtsClient | null = null;
/** Tests inject a fake client; the real API is never called from the test suite. */
export const __setTtsClientForTest = (c: TtsClient | null) => {
  override = c;
  failures = 0;
  openUntil = 0;
};

const client = (): TtsClient | null => override ?? (env.isTest || !env.ELEVENLABS_API_KEY ? null : elevenLabsClient);

/** True when ElevenLabs can be used at all (feature on, key present). Per-business choice is checked separately. */
export const ttsEnabled = () => flags.elevenLabsVoice() && client() !== null;

// ---- circuit breaker: after repeated failures stop trying for a minute so callers don't each wait for a timeout ----
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
let failures = 0;
let openUntil = 0;
const noteFailure = (why: string) => {
  failures += 1;
  logger.warn("ElevenLabs speech failed; using the standard voice", { why });
  if (failures >= BREAKER_THRESHOLD) {
    openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    failures = 0;
    logger.warn("ElevenLabs paused for 60 s after repeated failures");
  }
};

const MAX_CHARS = 1200;
const normalizeText = (t: string) => t.replace(/\s+/g, " ").trim();

async function synthesize(text: string, voiceId: string, timeoutMs: number) {
  const c = client();
  if (!c) throw new Error("ElevenLabs is not configured");
  const out = await c.synthesize({ text, voiceId, model: env.ELEVENLABS_MODEL, signal: AbortSignal.timeout(timeoutMs) });
  if (!out.audio?.byteLength) throw new Error("ElevenLabs returned no audio");
  return out;
}

// ---- signed, short-lived audio URLs (Twilio fetches them without a login) ----
export const CLIP_URL_TTL_MS = 15 * 60_000;
const secret = () => process.env.JWT_SECRET ?? env.JWT_SECRET ?? "";
const sign = (id: string, exp: number) => crypto.createHmac("sha256", secret()).update(`voice-clip:${id}.${exp}`).digest("base64url");

export function signClipUrl(clipId: string, now = Date.now()) {
  const exp = now + CLIP_URL_TTL_MS;
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/voice/audio/${clipId}?exp=${exp}&sig=${sign(clipId, exp)}`;
}

export function verifyClipSignature(clipId: string, exp: number, sig: string, now = Date.now()) {
  if (!clipId || !Number.isFinite(exp) || exp < now || !sig) return false;
  return secureEqual(sig, sign(clipId, exp));
}

/**
 * Speech for one reply as a URL Twilio can <Play>, or `null` to fall back to the standard voice.
 * Identical text for the same business and voice is generated once and reused.
 */
export async function speakText(p: { businessId: Types.ObjectId; text: string; gender: VoiceGender; voiceId?: string | null }): Promise<string | null> {
  if (!ttsEnabled()) return null;
  const text = normalizeText(p.text);
  if (!text || text.length > MAX_CHARS) return null;
  if (Date.now() < openUntil) return null;

  const voiceId = resolveVoiceId(p.gender, p.voiceId);
  const key = crypto.createHash("sha256").update(`${voiceId}|${env.ELEVENLABS_MODEL}|${text}`).digest("hex");
  const expiresAt = new Date(Date.now() + env.ELEVENLABS_CLIP_TTL_MINUTES * 60_000);
  try {
    const cached = await VoiceClip.findOneAndUpdate({ businessId: p.businessId, key }, { $max: { expiresAt } }, { returnDocument: "after" }).select("_id");
    if (cached) return signClipUrl(String(cached._id));

    const { audio, contentType } = await synthesize(text, voiceId, env.ELEVENLABS_TTS_TIMEOUT_MS);
    let clip;
    try {
      clip = await VoiceClip.findOneAndUpdate(
        { businessId: p.businessId, key },
        { $setOnInsert: { audio: Buffer.from(audio), contentType, bytes: audio.byteLength }, $max: { expiresAt } },
        { upsert: true, returnDocument: "after" },
      ).select("_id");
    } catch (e) {
      // Two calls generated the same phrase at once: the other one won the insert; use it.
      if ((e as { code?: number }).code !== 11000) throw e;
      clip = await VoiceClip.findOne({ businessId: p.businessId, key }).select("_id");
    }
    if (!clip) throw new Error("Could not store speech audio");
    failures = 0;
    return signClipUrl(String(clip._id));
  } catch (e) {
    noteFailure((e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message);
    return null;
  }
}

/** One-off audio for the Settings "Preview voice" button. Not stored. Throws if ElevenLabs is unavailable. */
export async function synthesizePreview(text: string, gender: VoiceGender, voiceId?: string | null) {
  if (!ttsEnabled()) throw new Error("ElevenLabs is not configured");
  return synthesize(normalizeText(text).slice(0, 400), resolveVoiceId(gender, voiceId), 8000);
}
