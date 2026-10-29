import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

const transcriptSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", required: true, unique: true },
    segments: [
      {
        _id: false,
        /** Stable id: the client's message id for caller lines, a generated response id for agent lines. */
        id: { type: String },
        /** For agent lines: the id of the caller message this answers. */
        replyTo: { type: String },
        role: { type: String, enum: ["agent", "caller", "system", "tool"], required: true },
        text: { type: String, required: true },
        at: { type: Date, default: () => new Date() },
        /** Time the agent took to produce this reply (agent segments only). */
        latencyMs: { type: Number },
      },
    ],
  },
  { timestamps: true },
);

export type TranscriptAttrs = InferSchemaType<typeof transcriptSchema>;
export type TranscriptDoc = HydratedDocument<TranscriptAttrs>;
export const CallTranscript = defineModel("CallTranscript", transcriptSchema);
