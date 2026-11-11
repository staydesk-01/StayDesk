import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

/**
 * A short piece of synthesized speech (one reply or greeting) that Twilio fetches and plays.
 * Kept briefly so repeated phrases are not paid for twice, then removed automatically (TTL index).
 * Tenant-scoped: the cache key includes the business, so one business never reuses another's audio.
 * The audio is only ever returned through the signed, short-lived URL endpoint.
 */
const voiceClipSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    /** sha256 of voice + model + text. The text itself is not stored. */
    key: { type: String, required: true },
    audio: { type: Buffer, required: true, select: false },
    contentType: { type: String, default: "audio/mpeg" },
    bytes: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
voiceClipSchema.index({ businessId: 1, key: 1 }, { unique: true });
voiceClipSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type VoiceClipAttrs = InferSchemaType<typeof voiceClipSchema>;
export type VoiceClipDoc = HydratedDocument<VoiceClipAttrs>;
export const VoiceClip = defineModel("VoiceClip", voiceClipSchema);
