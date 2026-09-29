import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";
import { INTENTS, OUTCOMES } from "./enums";

const summarySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", required: true, unique: true },
    summary: { type: String, required: true },
    intent: { type: String, enum: INTENTS, default: "unknown" },
    outcome: { type: String, enum: OUTCOMES, default: "resolved" },
    nextAction: { type: String, default: "" },
    keyDetails: [{ _id: false, label: String, value: String }],
    generatedBy: { type: String, enum: ["ai", "template", "agent"], default: "template" },
  },
  { timestamps: true },
);

export type SummaryAttrs = InferSchemaType<typeof summarySchema>;
export type SummaryDoc = HydratedDocument<SummaryAttrs>;
export const CallSummary = defineModel("CallSummary", summarySchema);
