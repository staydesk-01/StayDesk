import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { Notification } from "../models";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";

export async function listNotifications(req: Request, res: Response) {
  const { businessId } = auth(req);
  const [notifications, unread] = await Promise.all([
    Notification.find({ businessId }).sort({ createdAt: -1 }).limit(30),
    Notification.countDocuments({ businessId, read: false }),
  ]);
  res.json({ notifications, unread });
}

export async function markRead(req: Request, res: Response) {
  const { businessId } = auth(req);
  const n = await Notification.findOneAndUpdate({ _id: toObjectId(String(req.params.id)), businessId }, { $set: { read: true } }, { returnDocument: "after" });
  if (!n) throw AppError.notFound("Notification not found");
  res.json({ notification: n });
}

export async function markAllRead(req: Request, res: Response) {
  await Notification.updateMany({ businessId: auth(req).businessId, read: false }, { $set: { read: true } });
  res.json({ ok: true });
}
