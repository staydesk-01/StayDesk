import { randomUUID } from "node:crypto";
import { Schema } from "mongoose";
import { defineModel } from "./_define";

export const LOGIN_OUTCOMES = ["success", "bad_password", "locked", "mfa_required", "mfa_failed", "inactive"] as const;
const loginSchema = new Schema(
  {
    /** Unknown for emails that do not exist, so the log never confirms an account. */
    businessId: { type: Schema.Types.ObjectId, ref: "Business", index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    email: { type: String, required: true, lowercase: true, index: true },
    outcome: { type: String, enum: LOGIN_OUTCOMES, required: true },
    ip: String,
    userAgent: { type: String, maxlength: 200 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
loginSchema.index({ email: 1, createdAt: -1 });
loginSchema.index({ businessId: 1, createdAt: -1 });
export const LoginEvent = defineModel("LoginEvent", loginSchema);

export const RECORDING_STATUSES = ["available", "deleted", "failed"] as const;
const recordingSchema = new Schema(
  {
    recordingId: { type: String, default: () => randomUUID(), unique: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", required: true, index: true },
    callUuid: { type: String, index: true },
    provider: { type: String, default: "twilio" },
    /** Provider's own id; unique per business so a re-delivered webhook cannot create a second record. */
    providerRecordingId: { type: String },
    /** Where the audio lives. Never returned to clients: playback goes through authenticated, short-lived links. */
    storage: { kind: { type: String, default: "provider_reference" }, ref: { type: String, select: false } },
    durationSeconds: Number,
    status: { type: String, enum: RECORDING_STATUSES, default: "available" },
    /** True only when the call flow played a recording notice before recording began. */
    consentAnnounced: { type: Boolean, default: false },
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, maxlength: 300 },
    retentionUntil: { type: Date, index: true },
    deletedAt: Date,
    deletedBy: String,
    /** Honest record of whether the provider copy was removed: "deleted", "failed", or "not_attempted". */
    providerDeletion: { type: String, default: "not_attempted" },
  },
  { timestamps: true },
);
recordingSchema.index({ businessId: 1, createdAt: -1 });
recordingSchema.index({ businessId: 1, providerRecordingId: 1 }, { unique: true, sparse: true });
export const Recording = defineModel("Recording", recordingSchema);

export const QA_STATUSES = ["pass", "fail", "needs_review", "not_tested"] as const;
/** A person's recorded result for a test scenario (live tests with real Twilio calls are only ever recorded here, by a person). */
const qaSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    scenarioId: { type: String, required: true },
    status: { type: String, enum: QA_STATUSES, required: true },
    notes: { type: String, maxlength: 2000, default: "" },
    /** Callers actually on the line at the same time in this test. */
    concurrency: { type: Number, min: 0, max: 1000 },
    testedBy: String,
    testedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
qaSchema.index({ businessId: 1, scenarioId: 1 }, { unique: true });
export const QaResult = defineModel("QaResult", qaSchema);
