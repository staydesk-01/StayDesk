import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";
import { OPPORTUNITY_STATUSES, OPPORTUNITY_TYPES } from "./enums";

const opportunitySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", index: true },
    type: { type: String, enum: OPPORTUNITY_TYPES, required: true },
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    details: { type: String, default: "" },
    /** AI/business estimate. Shown as "Potential Opportunity Value" – never claimed as revenue. */
    estimatedValue: { type: Number, default: 0, min: 0 },
    /** Only set by a staff member (or a connected backend) confirming the real transaction. */
    verifiedValue: { type: Number, min: 0 },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
    status: { type: String, enum: OPPORTUNITY_STATUSES, default: "new" },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

opportunitySchema.index({ businessId: 1, createdAt: -1 });

export type OpportunityAttrs = InferSchemaType<typeof opportunitySchema>;
export type OpportunityDoc = HydratedDocument<OpportunityAttrs>;
export const Opportunity = defineModel("Opportunity", opportunitySchema);
