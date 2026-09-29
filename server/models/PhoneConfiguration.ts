import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

const phoneConfigSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, unique: true },
    /** new_twilio: callers dial the StayDesk number directly. existing_number: carrier forwards busy/no-answer calls to it. */
    mode: { type: String, enum: ["new_twilio", "existing_number"], default: "new_twilio" },
    /** The Twilio number (E.164). Incoming calls are matched to the business by this value. */
    twilioNumber: { type: String, trim: true, unique: true, sparse: true, default: undefined },
    /** The business's existing public number (existing_number mode). */
    existingNumber: { type: String, trim: true, default: "" },
    provider: { type: String, enum: ["twilio", "telnyx"], default: "twilio" },
    voiceProvider: { type: String, enum: ["twilio_gather", "retell", "vapi"], default: "twilio_gather" },

    humanFirst: { type: Boolean, default: true },
    ringSeconds: { type: Number, default: 20, min: 5, max: 60 },
    noAnswerToAi: { type: Boolean, default: true },
    busyToAi: { type: Boolean, default: true },
    afterHoursToAi: { type: Boolean, default: true },
    overflowToAi: { type: Boolean, default: true },
    /** If this many human-handled calls are already active, new calls overflow to AI. */
    maxConcurrentHumanCalls: { type: Number, default: 1, min: 1, max: 50 },
    aiOnly: { type: Boolean, default: false },
    /** Where human transfers and human-first ringing go. Falls back to Business.escalationPhone. */
    humanNumber: { type: String, trim: true, default: "" },

    // Status indicators
    forwardingConfigured: { type: Boolean, default: false },
    agentActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type PhoneConfigAttrs = InferSchemaType<typeof phoneConfigSchema>;
export type PhoneConfigDoc = HydratedDocument<PhoneConfigAttrs>;
export const PhoneConfiguration = defineModel("PhoneConfiguration", phoneConfigSchema);
