import type { Types } from "mongoose";
import { FollowUp, PaymentApproval, Reservation } from "../../models";
import type { PaymentApprovalDoc, PaymentKind } from "../../models";
import { AppError } from "../../utils/errors";
import { notify } from "../notifications/notificationService";
import { publish } from "../realtime";
import { redactSensitive } from "../safety/sensitive";
import { getPaymentProvider } from "./provider";

export interface RequestApprovalInput {
  businessId: Types.ObjectId;
  callId?: Types.ObjectId;
  kind: PaymentKind;
  amount?: number;
  description: string;
  customerName?: string;
  customerPhone?: string;
  reservationCode?: string;
  isDemo?: boolean;
}

/**
 * Step 1-2 of the approval workflow: StayDesk PREPARES the request and tells staff. Nothing is charged or refunded here.
 * A follow-up is created too, so the request is visible (and not lost) even if no approver is online right now.
 */
export async function requestPaymentApproval(input: RequestApprovalInput): Promise<PaymentApprovalDoc> {
  // Idempotency: the same pending request for this call is returned, not duplicated.
  if (input.callId) {
    const dup = await PaymentApproval.findOne({ businessId: input.businessId, callId: input.callId, kind: input.kind, amount: input.amount ?? null, status: "pending", description: redactSensitive(input.description) });
    if (dup) return dup;
  }
  const reservation = input.reservationCode ? await Reservation.findOne({ businessId: input.businessId, confirmationCode: input.reservationCode.toUpperCase() }) : null;
  const approval = await PaymentApproval.create({
    businessId: input.businessId,
    callId: input.callId,
    reservationId: reservation?._id,
    kind: input.kind,
    amount: input.amount ?? reservation?.totalAmount,
    description: redactSensitive(input.description),
    customerName: input.customerName ?? "",
    customerPhone: input.customerPhone ?? "",
    processor: getPaymentProvider().id,
    history: [{ at: new Date(), action: "requested", by: "StayDesk AI", note: "Waiting for human approval" }],
    isDemo: input.isDemo ?? false,
  });

  const amountText = approval.amount != null ? ` of $${approval.amount.toFixed(2)}` : "";
  await FollowUp.create({
    businessId: input.businessId,
    callId: input.callId,
    customerName: input.customerName ?? "",
    phone: input.customerPhone ?? "",
    reason: `Payment approval needed: ${approval.kind}${amountText}. ${approval.description}`,
    priority: "high",
    dueAt: new Date(Date.now() + 4 * 3600_000),
    isDemo: input.isDemo ?? false,
  });
  await notify({
    businessId: input.businessId,
    type: "payment_approval",
    title: `Payment approval needed: ${approval.kind}${amountText}`,
    body: `${input.customerName || "A caller"}: ${approval.description}`,
    link: "/follow-ups",
    callId: input.callId,
    isDemo: input.isDemo ?? false,
  });
  publish(input.businessId, "followup.updated", { id: String(approval._id) });
  return approval;
}

/** Steps 3-5: a human approves or rejects; an authorized payment system then processes an approval. */
export async function decideApproval(
  businessId: Types.ObjectId,
  id: string,
  decision: { action: "approve" | "reject"; userId: Types.ObjectId; userName: string; note?: string },
): Promise<PaymentApprovalDoc> {
  const approval = await PaymentApproval.findOne({ _id: id, businessId }); // tenant-scoped
  if (!approval) throw AppError.notFound("Approval request not found");
  if (approval.status !== "pending") throw AppError.conflict(`This request is already ${approval.status}.`);

  approval.decidedBy = decision.userId;
  approval.decidedAt = new Date();
  approval.decisionNote = decision.note ?? "";
  approval.status = decision.action === "approve" ? "approved" : "rejected";
  approval.history.push({ at: new Date(), action: approval.status, by: decision.userName, note: decision.note ?? "" });
  await approval.save();

  const provider = getPaymentProvider();
  if (approval.status === "approved" && provider.automatic) {
    const result = await provider.process(approval);
    if (result.ok) {
      approval.status = "paid";
      approval.paymentRef = result.reference;
      approval.paidAt = new Date();
    } else {
      approval.status = "failed";
    }
    approval.history.push({ at: new Date(), action: approval.status, by: provider.id, note: result.ok ? result.reference : result.error });
    await approval.save();
  }
  return approval;
}

/** Manual processor: staff completed the payment in their own system and record that system's reference. */
export async function recordOutcome(
  businessId: Types.ObjectId,
  id: string,
  outcome: { result: "paid" | "failed"; reference?: string; userName: string },
): Promise<PaymentApprovalDoc> {
  const approval = await PaymentApproval.findOne({ _id: id, businessId });
  if (!approval) throw AppError.notFound("Approval request not found");
  if (approval.status !== "approved") throw AppError.conflict("Only an approved request can be marked paid or failed.");
  if (outcome.result === "paid" && !outcome.reference?.trim()) throw AppError.badRequest("Enter the payment reference from your payment system.");
  approval.status = outcome.result;
  if (outcome.result === "paid") {
    approval.paymentRef = outcome.reference!.trim();
    approval.paidAt = new Date();
  }
  approval.history.push({ at: new Date(), action: outcome.result, by: outcome.userName, note: outcome.reference ?? "" });
  await approval.save();
  return approval;
}
