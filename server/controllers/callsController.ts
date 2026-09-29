import type { Request, Response } from "../http";
import type { QueryFilter } from "mongoose";
import { auth } from "../middleware/auth";
import { Business, Call, CallSummary, CallTranscript, FollowUp, Opportunity, ServiceRequest } from "../models";
import type { CallAttrs } from "../models/Call";
import { audit } from "../services/auditService";
import { startOfLocalDay } from "../services/calls/businessHours";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";
import { callsQuery } from "../validators/api";

export async function listCalls(req: Request, res: Response) {
  const { businessId } = auth(req);
  const q = callsQuery.parse(req.query);
  const business = await Business.findById(businessId).select("timezone");

  const where: QueryFilter<CallAttrs> = { businessId };
  const now = new Date();
  if (q.range === "today") where.startedAt = { $gte: startOfLocalDay(now, business?.timezone ?? "UTC") };
  else if (q.range === "7d") where.startedAt = { $gte: new Date(now.getTime() - 7 * 86400_000) };
  else if (q.range === "30d") where.startedAt = { $gte: new Date(now.getTime() - 30 * 86400_000) };

  switch (q.filter) {
    case "ai":
      where.handledBy = { $in: ["ai", "ai_and_human"] };
      break;
    case "transferred":
      where.transferStatus = "answered";
      break;
    case "follow_up":
      where.followUpRequired = true;
      break;
    case "completed":
      where.status = { $in: ["completed", "human_transferred"] };
      break;
    case "failed":
      where.status = { $in: ["failed", "abandoned"] };
      break;
  }
  if (q.q) {
    const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    where.$or = [{ callerNumber: rx }, { callerName: rx }];
  }

  const [calls, total] = await Promise.all([
    Call.find(where)
      .sort({ startedAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .select("-agentState -actions"),
    Call.countDocuments(where),
  ]);
  res.json({ calls, total, page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)) });
}

export async function getCall(req: Request, res: Response) {
  const { businessId } = auth(req);
  const id = toObjectId(String(req.params.id));
  const call = await Call.findOne({ _id: id, businessId }).select("-agentState"); // tenant-scoped lookup
  if (!call) throw AppError.notFound("Call not found");
  const [transcript, summary, opportunities, serviceRequests, followUps] = await Promise.all([
    CallTranscript.findOne({ callId: id, businessId }),
    CallSummary.findOne({ callId: id, businessId }),
    Opportunity.find({ callId: id, businessId }),
    ServiceRequest.find({ callId: id, businessId }),
    FollowUp.find({ callId: id, businessId }).populate("assignedTo", "name"),
  ]);
  res.json({ call, transcript, summary, opportunities, serviceRequests, followUps });
}

/** Deletes a call and everything derived from its conversation (transcript, summary). Business records are kept, detached. */
export async function deleteCall(req: Request, res: Response) {
  const { businessId } = auth(req);
  const id = toObjectId(String(req.params.id));
  const call = await Call.findOne({ _id: id, businessId });
  if (!call) throw AppError.notFound("Call not found");
  await Promise.all([
    CallTranscript.deleteMany({ callId: id, businessId }),
    CallSummary.deleteMany({ callId: id, businessId }),
    Call.deleteOne({ _id: id, businessId }),
  ]);
  await audit(req, businessId, "call.delete", "call", id, { callerNumber: call.callerNumber });
  res.json({ ok: true });
}

export async function deleteTranscript(req: Request, res: Response) {
  const { businessId } = auth(req);
  const id = toObjectId(String(req.params.id));
  const call = await Call.findOne({ _id: id, businessId });
  if (!call) throw AppError.notFound("Call not found");
  await CallTranscript.deleteMany({ callId: id, businessId });
  await Call.updateOne({ _id: id }, { $unset: { transcriptId: 1 } });
  await audit(req, businessId, "transcript.delete", "call", id);
  res.json({ ok: true });
}
