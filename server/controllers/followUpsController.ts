import type { Request, Response } from "../http";
import type { QueryFilter, Types } from "mongoose";
import { auth } from "../middleware/auth";
import { Call, FollowUp, User } from "../models";
import type { FollowUpAttrs } from "../models/FollowUp";
import { audit } from "../services/auditService";
import { publish } from "../services/realtime";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";
import { followUpCreate, followUpPatch, followUpsQuery } from "../validators/api";

export async function listFollowUps(req: Request, res: Response) {
  const a = auth(req);
  const q = followUpsQuery.parse(req.query);
  const where: QueryFilter<FollowUpAttrs> = { businessId: a.businessId };
  if (q.status === "active") where.status = { $in: ["open", "in_progress"] };
  else if (q.status !== "all") where.status = q.status;
  if (q.priority) where.priority = q.priority;
  if (q.mine === "true") where.assignedTo = toObjectId(a.userId);
  if (q.callId) where.callId = toObjectId(q.callId);

  const [followUps, total, counts] = await Promise.all([
    FollowUp.find(where)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("assignedTo", "name")
      .populate("callId", "intent startedAt callerNumber callerName"),
    FollowUp.countDocuments(where),
    FollowUp.aggregate([{ $match: { businessId: a.businessId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  res.json({ followUps, total, counts: byStatus });
}

async function assertAssignee(businessId: Types.ObjectId, userId: string) {
  const u = await User.findOne({ _id: toObjectId(userId), businessId, active: true });
  if (!u) throw AppError.badRequest("Assignee must be an active member of your team");
  return u._id;
}

export async function createFollowUp(req: Request, res: Response) {
  const a = auth(req);
  const body = followUpCreate.parse(req.body);
  if (body.callId && !(await Call.exists({ _id: toObjectId(body.callId), businessId: a.businessId }))) throw AppError.notFound("Call not found");
  const followUp = await FollowUp.create({
    businessId: a.businessId,
    callId: body.callId ? toObjectId(body.callId) : undefined,
    customerName: body.customerName,
    phone: body.phone,
    reason: body.reason,
    priority: body.priority,
    dueAt: body.dueAt,
    assignedTo: body.assignedTo ? await assertAssignee(a.businessId, body.assignedTo) : undefined,
  });
  if (body.callId) await Call.updateOne({ _id: body.callId, businessId: a.businessId }, { $set: { followUpRequired: true } });
  await audit(req, a.businessId, "followup.create", "followUp", followUp._id);
  publish(a.businessId, "followup.updated", { id: String(followUp._id) });
  res.status(201).json({ followUp });
}

export async function patchFollowUp(req: Request, res: Response) {
  const a = auth(req);
  const patch = followUpPatch.parse(req.body);
  const followUp = await FollowUp.findOne({ _id: toObjectId(String(req.params.id)), businessId: a.businessId });
  if (!followUp) throw AppError.notFound("Follow-up not found");

  if (patch.status && patch.status !== followUp.status) {
    followUp.status = patch.status;
    followUp.completedAt = patch.status === "completed" ? new Date() : undefined;
  }
  if (patch.priority) followUp.priority = patch.priority;
  if (patch.dueAt !== undefined) followUp.dueAt = patch.dueAt ?? undefined;
  if (patch.assignedTo !== undefined) {
    followUp.assignedTo = patch.assignedTo ? await assertAssignee(a.businessId, patch.assignedTo) : undefined;
    if (patch.assignedTo && followUp.status === "open") followUp.status = "in_progress";
  }
  if (patch.note) followUp.notes.push({ text: patch.note, authorId: toObjectId(a.userId), authorName: a.name, at: new Date() });
  await followUp.save();

  // Keep the call's "needs follow-up" flag honest.
  if (followUp.callId) {
    const stillOpen = await FollowUp.exists({ callId: followUp.callId, businessId: a.businessId, status: { $in: ["open", "in_progress"] } });
    await Call.updateOne({ _id: followUp.callId, businessId: a.businessId }, { $set: { followUpRequired: !!stillOpen } });
  }
  await audit(req, a.businessId, "followup.update", "followUp", followUp._id, { fields: Object.keys(patch) });
  publish(a.businessId, "followup.updated", { id: String(followUp._id) });
  const populated = await followUp.populate("assignedTo", "name");
  res.json({ followUp: populated });
}
