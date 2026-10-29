import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";
import { BUSINESS_TYPES, NOTIFICATION_TYPES } from "./enums";

const businessSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: BUSINESS_TYPES, required: true, default: "other" },
    phone: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    timezone: { type: String, default: "America/New_York" },
    /** Number the AI dials when a caller asks for a person. */
    escalationPhone: { type: String, trim: true, default: "" },
    ownerEmail: { type: String, trim: true, lowercase: true, default: "" },
    agentName: { type: String, default: "StayDesk assistant" },
    /** BCP-47 language the voice agent listens for and speaks (speech recognition + voice). */
    language: { type: String, enum: ["en-US", "es-US", "fr-FR", "de-DE", "pt-BR"], default: "en-US" },
    notificationPrefs: {
      inApp: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      events: {
        type: [String],
        enum: NOTIFICATION_TYPES,
        default: [
          "high_value_lead",
          "booking_inquiry",
          "urgent_request",
          "transfer_failed",
          "callback_requested",
          "unresolved_request",
        ],
      },
      /** Opportunities with an estimated value at or above this are "high value". */
      highValueThreshold: { type: Number, default: 500 },
    },
    /** Outbound calling is OFF until the business enables it and approves each purpose. */
    outbound: {
      enabled: { type: Boolean, default: false },
      purposes: { type: [String], default: [] },
      /** Local time at the RECIPIENT. Never wider than 08:00-21:00 (clamped when evaluated). */
      windowStart: { type: String, default: "09:00" },
      windowEnd: { type: String, default: "20:00" },
      maxAttempts: { type: Number, default: 2, min: 1, max: 5 },
      retryMinutes: { type: Number, default: 120, min: 15, max: 1440 },
      /** Free text the owner records, e.g. "US - existing customers only; reviewed by counsel". Shown in audits. */
      jurisdictionNote: { type: String, default: "" },
    },
    privacy: {
      /** Recording is OFF unless the business explicitly turns it on. */
      recordingEnabled: { type: Boolean, default: false },
      recordingConsentMessage: {
        type: String,
        default: "This call may be recorded to help us serve you better.",
      },
      transcriptRetentionDays: { type: Number, default: 90, min: 1, max: 3650 },
    },
    onboardingComplete: { type: Boolean, default: false },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type BusinessAttrs = InferSchemaType<typeof businessSchema>;
export type BusinessDoc = HydratedDocument<BusinessAttrs>;
export const Business = defineModel("Business", businessSchema);
