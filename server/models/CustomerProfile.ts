import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

/**
 * What StayDesk remembers about a returning caller, per business (never shared across businesses).
 * Keyed by the caller's phone number, which is NOT proof of identity: details are never read back to the caller
 * until they verify (e.g. reservation code + last name). Medical businesses keep only counts and intents, no free text.
 */
const customerProfileSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    phone: { type: String, required: true },
    name: { type: String, default: "" },
    callCount: { type: Number, default: 0 },
    firstSeenAt: { type: Date, default: () => new Date() },
    lastCallAt: { type: Date, default: () => new Date() },
    lastLanguage: { type: String, default: "" },
    interactions: [
      {
        _id: false,
        callId: { type: Schema.Types.ObjectId, ref: "Call" },
        at: Date,
        intent: String,
        outcome: String,
        /** Redacted, truncated first request. Empty for medical businesses. */
        request: { type: String, default: "" },
        nextStep: { type: String, default: "" },
      },
    ],
    /** Caller asked not to be remembered: no further data is stored for this number. */
    optedOut: { type: Boolean, default: false },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);
customerProfileSchema.index({ businessId: 1, phone: 1 }, { unique: true });

export type CustomerProfileAttrs = InferSchemaType<typeof customerProfileSchema>;
export type CustomerProfileDoc = HydratedDocument<CustomerProfileAttrs>;
export const CustomerProfile = defineModel("CustomerProfile", customerProfileSchema);
