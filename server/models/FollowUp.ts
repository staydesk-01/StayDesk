import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";
import { FOLLOW_UP_STATUSES, PRIORITIES } from "./enums";

const followUpSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", index: true },
    customerName: { type: String, default: "" },
    phone: { type: String, default: "" },
    reason: { type: String, required: true },
    priority: { type: String, enum: PRIORITIES, default: "normal" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    status: { type: String, enum: FOLLOW_UP_STATUSES, default: "open" },
    notes: [
      {
        _id: false,
        text: String,
        authorId: { type: Schema.Types.ObjectId, ref: "User" },
        authorName: String,
        at: { type: Date, default: () => new Date() },
      },
    ],
    dueAt: { type: Date },
    completedAt: { type: Date },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

followUpSchema.index({ businessId: 1, status: 1, createdAt: -1 });

export type FollowUpAttrs = InferSchemaType<typeof followUpSchema>;
export type FollowUpDoc = HydratedDocument<FollowUpAttrs>;
export const FollowUp = defineModel("FollowUp", followUpSchema);
