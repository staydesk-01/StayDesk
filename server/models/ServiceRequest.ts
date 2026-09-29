import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";
import { PRIORITIES, SERVICE_REQUEST_STATUSES } from "./enums";

const serviceRequestSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", index: true },
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    category: { type: String, default: "general" },
    description: { type: String, required: true },
    location: { type: String, default: "" }, // e.g. room number
    urgency: { type: String, enum: PRIORITIES, default: "normal" },
    status: { type: String, enum: SERVICE_REQUEST_STATUSES, default: "open" },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

serviceRequestSchema.index({ businessId: 1, createdAt: -1 });

export type ServiceRequestAttrs = InferSchemaType<typeof serviceRequestSchema>;
export type ServiceRequestDoc = HydratedDocument<ServiceRequestAttrs>;
export const ServiceRequest = defineModel("ServiceRequest", serviceRequestSchema);
