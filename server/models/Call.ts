import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";
import {
  CALL_PROVIDERS,
  CALL_STATUSES,
  HANDLED_BY,
  INTENTS,
  OUTCOMES,
  ROUTING_REASONS,
  TRANSFER_STATUSES,
} from "./enums";

const callSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    provider: { type: String, enum: CALL_PROVIDERS, required: true },
    providerCallId: { type: String, required: true },
    callerNumber: { type: String, default: "" },
    callerName: { type: String, default: "" },
    businessNumber: { type: String, default: "" },
    routingReason: { type: String, enum: ROUTING_REASONS, required: true },
    handledBy: { type: String, enum: HANDLED_BY, default: "ai" },
    intent: { type: String, enum: INTENTS, default: "unknown" },
    status: { type: String, enum: CALL_STATUSES, default: "ringing" },
    outcome: { type: String, enum: OUTCOMES, default: "in_progress" },
    startedAt: { type: Date, default: () => new Date() },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    durationSeconds: { type: Number, default: 0 },
    transcriptId: { type: Schema.Types.ObjectId, ref: "CallTranscript" },
    summaryId: { type: Schema.Types.ObjectId, ref: "CallSummary" },
    followUpRequired: { type: Boolean, default: false },

    transferAttempted: { type: Boolean, default: false },
    transferStatus: { type: String, enum: TRANSFER_STATUSES, default: "none" },
    transfer: {
      transferStartedAt: Date,
      transferNumber: String,
      transferAnsweredAt: Date,
      attempts: [
        {
          _id: false,
          startedAt: Date,
          number: String,
          status: { type: String, enum: TRANSFER_STATUSES },
          answeredAt: Date,
          reason: String,
        },
      ],
    },

    /** Tool calls the agent made during this call (audit trail shown on the call page). */
    actions: [
      {
        _id: false,
        tool: String,
        at: { type: Date, default: () => new Date() },
        ok: Boolean,
        summary: String,
      },
    ],
    /** Conversation state for the built-in agent between webhook turns. */
    agentState: { type: Schema.Types.Mixed, default: {} },
    /** Set by request_human_transfer; the telephony layer turns it into a <Dial>. */
    pendingTransfer: { type: Boolean, default: false },

    recording: {
      enabled: { type: Boolean, default: false },
      url: String,
      sid: String,
      durationSeconds: Number,
    },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

callSchema.index({ businessId: 1, startedAt: -1 });
callSchema.index({ provider: 1, providerCallId: 1 }, { unique: true });

export type CallAttrs = InferSchemaType<typeof callSchema>;
export type CallDoc = HydratedDocument<CallAttrs>;
export const Call = defineModel("Call", callSchema);
