import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { PAYMENT_KINDS, PAYMENT_STATUSES } from "./enums";
import { defineModel } from "./_define";

/**
 * A payment-related request that a HUMAN must approve. By design this model has no field for card numbers,
 * CVV, bank details or any other raw payment data: those never enter StayDesk transcripts or records.
 */
const paymentApprovalSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "Call", index: true },
    reservationId: { type: Schema.Types.ObjectId, ref: "Reservation" },
    kind: { type: String, enum: PAYMENT_KINDS, required: true },
    amount: { type: Number, min: 0 }, // dollars; may be unknown until staff decide
    currency: { type: String, default: "USD" },
    description: { type: String, required: true },
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    status: { type: String, enum: PAYMENT_STATUSES, default: "pending", index: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User" },
    decidedAt: { type: Date },
    decisionNote: { type: String, default: "" },
    /** Which payment system carries out an approved payment ("manual" = staff process it in their own POS/processor). */
    processor: { type: String, default: "manual" },
    /** Reference returned by the payment system. Only set once the payment is actually confirmed by it. */
    paymentRef: { type: String },
    paidAt: { type: Date },
    history: [{ _id: false, at: { type: Date, default: () => new Date() }, action: String, by: String, note: String }],
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);
paymentApprovalSchema.index({ businessId: 1, status: 1, createdAt: -1 });

export type PaymentApprovalAttrs = InferSchemaType<typeof paymentApprovalSchema>;
export type PaymentApprovalDoc = HydratedDocument<PaymentApprovalAttrs>;
export const PaymentApproval = defineModel("PaymentApproval", paymentApprovalSchema);
