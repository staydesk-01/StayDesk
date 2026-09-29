import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

const transcriptSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", required: true, unique: true },
    segments: [
      {
        _id: false,
        role: { type: String, enum: ["agent", "caller", "system", "tool"], required: true },
        text: { type: String, required: true },
        at: { type: Date, default: () => new Date() },
      },
    ],
  },
  { timestamps: true },
);

export type TranscriptAttrs = InferSchemaType<typeof transcriptSchema>;
export type TranscriptDoc = HydratedDocument<TranscriptAttrs>;
export const CallTranscript = defineModel("CallTranscript", transcriptSchema);
