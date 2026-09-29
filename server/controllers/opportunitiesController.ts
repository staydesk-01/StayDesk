import type { Request, Response } from "../http";
import type { QueryFilter } from "mongoose";
import { auth } from "../middleware/auth";
import { Opportunity, ServiceRequest } from "../models";
import type { OpportunityAttrs } from "../models/Opportunity";
import { audit } from "../services/auditService";
import { publish } from "../services/realtime";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";
import { opportunitiesQuery, opportunityPatch, serviceRequestPatch } from "../validators/api";

export async function listOpportunities(req: Request, res: Response) {
  const { businessId } = auth(req);
  const q = opportunitiesQuery.parse(req.query);
  const where: QueryFilter<OpportunityAttrs> = { businessId };
  if (q.status !== "all") where.status = q.status;
  const [opportunities, total, all] = await Promise.all([
    Opportunity.find(where)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("callId", "startedAt callerNumber"),
    Opportunity.countDocuments(where),
    Opportunity.find({ businessId }).select("status estimatedValue verifiedValue"),
  ]);
  // Two deliberately separate numbers: verified revenue is only what staff confirmed.
  const potentialValue = all.filter((o) => o.status === "new" || o.status === "contacted").reduce((s, o) => s + (o.estimatedValue ?? 0), 0);
  const verifiedRevenue = all.filter((o) => o.status === "converted" && o.verifiedValue != null).reduce((s, o) => s + (o.verifiedValue ?? 0), 0);
  res.json({ opportunities, total, totals: { potentialValue, verifiedRevenue } });
}

export async function patchOpportunity(req: Request, res: Response) {
  const a = auth(req);
  const patch = opportunityPatch.parse(req.body);
  const opp = await Opportunity.findOne({ _id: toObjectId(String(req.params.id)), businessId: a.businessId });
  if (!opp) throw AppError.notFound("Opportunity not found");

  if (patch.status) opp.status = patch.status;
  if (patch.estimatedValue !== undefined) opp.estimatedValue = patch.estimatedValue;
  if (patch.verifiedValue !== undefined) {
    if (patch.verifiedValue !== null && opp.status !== "converted") {
      throw AppError.badRequest("Verified revenue can only be recorded on a converted opportunity");
    }
    if (patch.verifiedValue === null) {
      opp.verifiedValue = undefined;
      opp.verifiedBy = undefined;
      opp.verifiedAt = undefined;
    } else {
      opp.verifiedValue = patch.verifiedValue;
      opp.verifiedBy = toObjectId(a.userId);
      opp.verifiedAt = new Date();
    }
  }
  // Moving away from "converted" invalidates any previously verified amount.
  if (opp.status !== "converted" && opp.verifiedValue != null) {
    opp.verifiedValue = undefined;
    opp.verifiedBy = undefined;
    opp.verifiedAt = undefined;
  }
  await opp.save();
  await audit(req, a.businessId, "opportunity.update", "opportunity", opp._id, patch as Record<string, unknown>);
  publish(a.businessId, "opportunity.updated", { id: String(opp._id) });
  res.json({ opportunity: opp });
}

export async function listServiceRequests(req: Request, res: Response) {
  const { businessId } = auth(req);
  const serviceRequests = await ServiceRequest.find({ businessId }).sort({ createdAt: -1 }).limit(100);
  res.json({ serviceRequests });
}

export async function patchServiceRequest(req: Request, res: Response) {
  const a = auth(req);
  const { status } = serviceRequestPatch.parse(req.body);
  const sr = await ServiceRequest.findOneAndUpdate({ _id: toObjectId(String(req.params.id)), businessId: a.businessId }, { $set: { status } }, { returnDocument: "after" });
  if (!sr) throw AppError.notFound("Service request not found");
  await audit(req, a.businessId, "servicerequest.update", "serviceRequest", sr._id, { status });
  res.json({ serviceRequest: sr });
}
