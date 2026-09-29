import type { Types } from "mongoose";
import { env } from "../../config/env";
import { Business, Notification } from "../../models";
import type { NotificationType } from "../../models";
import { publish } from "../realtime";
import { sendEmail } from "./email";

export interface NotifyInput {
  businessId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  callId?: Types.ObjectId;
  isDemo?: boolean;
}

/**
 * Creates an in-app notification and (per business preferences) an email.
 * Notifications are de-duplicated per call + type so repeated tool calls do not spam the owner.
 */
export async function notify(input: NotifyInput) {
  const business = await Business.findById(input.businessId);
  if (!business) return null;
  const prefs = business.notificationPrefs!; // nested paths always exist (schema defaults)
  if (!prefs.events.includes(input.type) && input.type !== "info") return null;
  if (!prefs.inApp && !prefs.email) return null;

  if (input.callId) {
    const existing = await Notification.findOne({ businessId: input.businessId, callId: input.callId, type: input.type });
    if (existing) return existing;
  }

  const notification = await Notification.create({
    businessId: input.businessId,
    type: input.type,
    title: input.title,
    body: input.body ?? "",
    link: input.link ?? (input.callId ? `/calls/${input.callId}` : ""),
    callId: input.callId,
    isDemo: input.isDemo ?? false,
    channels: { inApp: prefs.inApp, email: "none" },
  });

  if (prefs.email && business.ownerEmail) {
    const result = await sendEmail({
      to: business.ownerEmail,
      subject: input.title,
      text: input.body ?? "",
      link: notification.link ? `${env.FRONTEND_URL}${notification.link}` : undefined,
    });
    notification.channels!.email = result;
    await notification.save();
  }

  publish(input.businessId, "notification.created", { id: String(notification._id) });
  return notification;
}
