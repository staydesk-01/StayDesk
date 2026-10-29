import { Schema } from "mongoose";
import { defineModel } from "./_define";

/**
 * Idempotency ledger: one row per (call, message id). A retried request with the same id returns the stored reply
 * instead of running the agent (and its backend actions) again. Expires on its own.
 */
const processedMessageSchema = new Schema(
  {
    callId: { type: Schema.Types.ObjectId, ref: "Call", required: true },
    messageId: { type: String, required: true },
    status: { type: String, enum: ["processing", "done"], default: "processing" },
    result: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: () => new Date(), expires: 86400 * 2 },
  },
  { versionKey: false },
);
processedMessageSchema.index({ callId: 1, messageId: 1 }, { unique: true });

export const ProcessedMessage = defineModel("ProcessedMessage", processedMessageSchema);
