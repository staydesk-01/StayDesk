import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";
import { NOTIFICATION_TYPES } from "./enums";

const notificationSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    link: { type: String, default: "" },
    callId: { type: Schema.Types.ObjectId, ref: "Call" },
    read: { type: Boolean, default: false },
    channels: {
      inApp: { type: Boolean, default: false },
      email: { type: String, enum: ["none", "sent", "skipped", "failed"], default: "none" },
    },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index({ businessId: 1, createdAt: -1 });

export type NotificationAttrs = InferSchemaType<typeof notificationSchema>;
export type NotificationDoc = HydratedDocument<NotificationAttrs>;
export const Notification = defineModel("Notification", notificationSchema);
