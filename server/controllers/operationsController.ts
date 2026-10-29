import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { PaymentApproval, Reservation, RoomType } from "../models";
import { audit } from "../services/auditService";
import { decideApproval, recordOutcome } from "../services/payments/paymentService";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";
import { inventoryBody, paymentDecisionBody, paymentsQuery } from "../validators/api";

// ---- Payment approvals (human-in-the-loop) -------------------------------------------------------
export async function listPaymentApprovals(req: Request, res: Response) {
  const { businessId } = auth(req);
  const q = paymentsQuery.parse(req.query);
  const where: Record<string, unknown> = { businessId };
  if (q.status === "open") where.status = { $in: ["pending", "approved"] }; // needs a decision or still needs processing
  else if (q.status !== "all") where.status = q.status;
  const [approvals, pending] = await Promise.all([
    PaymentApproval.find(where).sort({ createdAt: -1 }).limit(q.limit).populate("decidedBy", "name"),
    PaymentApproval.countDocuments({ businessId, status: "pending" }),
  ]);
  res.json({ approvals, pending });
}

/** Only owners/admins decide (enforced in the route). The AI can never reach this endpoint. */
export async function decidePaymentApproval(req: Request, res: Response) {
  const a = auth(req);
  const body = paymentDecisionBody.parse(req.body);
  const id = String(req.params.id);
  toObjectId(id);
  const userId = toObjectId(a.userId);

  const approval =
    body.action === "approve" || body.action === "reject"
      ? await decideApproval(a.businessId, id, { action: body.action, userId, userName: a.name, note: body.note })
      : await recordOutcome(a.businessId, id, { result: body.action === "mark_paid" ? "paid" : "failed", reference: body.action === "mark_paid" ? body.reference : undefined, userName: a.name });
  await audit(req, a.businessId, `payment.${body.action}`, "paymentApproval", approval._id, { kind: approval.kind, amount: approval.amount, status: approval.status });
  res.json({ approval });
}

// ---- Reservations & inventory --------------------------------------------------------------------
export async function listReservations(req: Request, res: Response) {
  const { businessId } = auth(req);
  const reservations = await Reservation.find({ businessId }).sort({ createdAt: -1 }).limit(100);
  res.json({ reservations });
}

export async function getInventory(req: Request, res: Response) {
  const roomTypes = await RoomType.find({ businessId: auth(req).businessId, active: true }).sort({ nightlyRate: 1 });
  res.json({ roomTypes });
}

/** Replaces the bookable room list. Removed types are deactivated (not deleted) so existing reservations stay valid. */
export async function putInventory(req: Request, res: Response) {
  const { businessId } = auth(req);
  const { roomTypes } = inventoryBody.parse(req.body);
  const names = roomTypes.map((r) => r.name);
  await RoomType.updateMany({ businessId, name: { $nin: names } }, { $set: { active: false } });
  for (const r of roomTypes) {
    await RoomType.updateOne({ businessId, name: r.name }, { $set: { ...r, active: true } }, { upsert: true });
  }
  await audit(req, businessId, "inventory.update", "roomType", undefined, { count: roomTypes.length });
  res.json({ roomTypes: await RoomType.find({ businessId, active: true }).sort({ nightlyRate: 1 }) });
}

// ---- Evaluation report (simulated conversations; never mixed into production metrics) ---------------
export async function getEvaluation(_req: Request, res: Response) {
  const file = path.resolve(process.cwd(), "evals/reports/latest.json");
  if (!fs.existsSync(file)) {
    res.json({ report: null });
    return;
  }
  try {
    res.json({ report: JSON.parse(fs.readFileSync(file, "utf8")) });
  } catch {
    throw AppError.badRequest("The latest evaluation report is unreadable. Run `npm run eval` again.");
  }
}
