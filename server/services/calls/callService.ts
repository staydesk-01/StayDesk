import type { Types } from "mongoose";
import {
  Business,
  Call,
  CallSummary,
  CallTranscript,
  FollowUp,
  Opportunity,
  ServiceRequest,
} from "../../models";
import type { CallDoc, CallProvider, CallStatus, Intent, Outcome, RoutingReason } from "../../models";
import { ACTIONABLE_INTENTS, mergeIntent } from "../ai/intent";
import { notify } from "../notifications/notificationService";
import { publish } from "../realtime";
import { generateSummary } from "./summaryService";

export interface CreateCallInput {
  businessId: Types.ObjectId;
  provider: CallProvider;
  providerCallId: string;
  callerNumber: string;
  businessNumber: string;
  routingReason: RoutingReason;
  handledBy?: "ai" | "human";
  status?: CallStatus;
  isDemo?: boolean;
}

/** Idempotent: Twilio may retry webhooks, so the same providerCallId returns the existing session. */
export async function createCallSession(input: CreateCallInput): Promise<CallDoc> {
  const existing = await Call.findOne({ provider: input.provider, providerCallId: input.providerCallId });
  if (existing) return existing;
  try {
    const call = await Call.create({
      ...input,
      handledBy: input.handledBy ?? "ai",
      status: input.status ?? "ringing",
      startedAt: new Date(),
    });
    publish(call.businessId, "call.created", { id: String(call._id) });
    return call;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const again = await Call.findOne({ provider: input.provider, providerCallId: input.providerCallId });
      if (again) return again;
    }
    throw e;
  }
}

export async function appendTranscript(
  call: { _id: Types.ObjectId; businessId: Types.ObjectId },
  role: "agent" | "caller" | "system" | "tool",
  text: string,
) {
  if (!text.trim()) return;
  const transcript = await CallTranscript.findOneAndUpdate(
    { callId: call._id, businessId: call.businessId },
    { $push: { segments: { role, text: text.trim(), at: new Date() } }, $setOnInsert: { callId: call._id, businessId: call.businessId } },
    { upsert: true, returnDocument: "after" },
  );
  await Call.updateOne({ _id: call._id, transcriptId: { $exists: false } }, { $set: { transcriptId: transcript._id } });
  publish(call.businessId, "call.updated", { id: String(call._id) });
}

export async function recordAction(callId: Types.ObjectId, tool: string, ok: boolean, summary: string) {
  await Call.updateOne({ _id: callId }, { $push: { actions: { tool, at: new Date(), ok, summary: summary.slice(0, 300) } } });
}

export async function bumpIntent(callId: Types.ObjectId, next: Intent): Promise<Intent> {
  const call = await Call.findById(callId).select("intent businessId");
  if (!call) return next;
  const merged = mergeIntent(call.intent as Intent, next);
  if (merged !== call.intent) {
    await Call.updateOne({ _id: callId }, { $set: { intent: merged } });
    publish(call.businessId, "call.updated", { id: String(callId) });
  }
  return merged;
}

function deriveOutcome(c: {
  status: CallStatus;
  transferStatus: string;
  opportunities: number;
  serviceRequests: number;
  followUps: number;
}): Outcome {
  if (c.status === "abandoned") return "abandoned";
  if (c.status === "failed") return "failed";
  if (c.transferStatus === "answered") return "transferred";
  if (c.opportunities) return "opportunity_captured";
  if (c.serviceRequests) return "service_request_created";
  if (c.followUps) return "follow_up_created";
  return "resolved";
}

export interface FinalizeOptions {
  endedAt?: Date;
  durationSeconds?: number;
  forceStatus?: CallStatus;
}

/**
 * Ends a call exactly once (atomic claim on endedAt), then: derives status + outcome, creates a follow-up
 * when the AI could not complete an actionable request, saves the summary, and alerts the business.
 */
export async function finalizeCall(callId: Types.ObjectId | string, opts: FinalizeOptions = {}): Promise<CallDoc | null> {
  const endedAt = opts.endedAt ?? new Date();
  const claimed = await Call.findOneAndUpdate({ _id: callId, endedAt: null }, { $set: { endedAt } }, { returnDocument: "after" });
  if (!claimed) return Call.findById(callId); // already finalized (or unknown)
  const call = claimed;

  const [transcript, opportunities, serviceRequests, followUps, business] = await Promise.all([
    CallTranscript.findOne({ callId: call._id }),
    Opportunity.countDocuments({ callId: call._id }),
    ServiceRequest.countDocuments({ callId: call._id }),
    FollowUp.countDocuments({ callId: call._id }),
    Business.findById(call.businessId),
  ]);
  const callerTurns = transcript?.segments.filter((s) => s.role === "caller").length ?? 0;
  const anyAction = opportunities + serviceRequests + followUps > 0 || call.transferStatus === "answered";

  const started = call.answeredAt ?? call.startedAt;
  call.durationSeconds = opts.durationSeconds ?? Math.max(0, Math.round((endedAt.getTime() - started.getTime()) / 1000));

  let status: CallStatus = call.status;
  if (opts.forceStatus) status = opts.forceStatus;
  else if (call.transferStatus === "answered") status = "human_transferred";
  else if (call.handledBy === "human" && call.answeredAt) status = "completed";
  else if (status === "ringing" || (callerTurns === 0 && !anyAction && call.provider !== "simulator")) status = "abandoned";
  else status = "completed";
  call.status = status;

  const aiInvolved = call.handledBy !== "human";
  const link = `/calls/${call._id}`;

  // Safety nets so nothing that needed a human is silently lost.
  let createdFollowUps = followUps;
  if (aiInvolved && status === "completed" && !anyAction) {
    const actionable = ACTIONABLE_INTENTS.includes(call.intent as Intent) || (call.intent === "unknown" && callerTurns >= 2);
    if (actionable) {
      await FollowUp.create({
        businessId: call.businessId,
        callId: call._id,
        customerName: call.callerName,
        phone: call.callerNumber,
        reason: "The AI could not fully complete this caller's request. Review the conversation and call them back.",
        priority: call.intent === "urgent_request" || call.intent === "complaint" ? "high" : "normal",
        dueAt: new Date(Date.now() + 4 * 3600_000),
        isDemo: call.isDemo,
      });
      createdFollowUps += 1;
      await notify({
        businessId: call.businessId,
        type: "unresolved_request",
        title: "AI could not resolve a caller's request",
        body: `${call.callerName || call.callerNumber || "A caller"} needs a follow-up.`,
        link,
        callId: call._id,
        isDemo: call.isDemo,
      });
    }
  }
  if (status === "abandoned" && call.provider !== "simulator") {
    await FollowUp.create({
      businessId: call.businessId,
      callId: call._id,
      customerName: call.callerName,
      phone: call.callerNumber,
      reason: "Caller hung up before anyone could help. Consider calling them back.",
      priority: "normal",
      dueAt: new Date(Date.now() + 8 * 3600_000),
      isDemo: call.isDemo,
    });
    createdFollowUps += 1;
  }

  call.outcome = deriveOutcome({
    status,
    transferStatus: call.transferStatus,
    opportunities,
    serviceRequests,
    followUps: createdFollowUps,
  });
  call.followUpRequired = createdFollowUps > 0;
  call.pendingTransfer = false;

  // Summary: keep one the agent saved itself, otherwise generate.
  let summary = await CallSummary.findOne({ callId: call._id });
  if (!summary && business && status !== "abandoned") {
    const draft = await generateSummary(call, transcript, business.name);
    summary = await CallSummary.create({
      businessId: call.businessId,
      callId: call._id,
      summary: draft.summary,
      intent: draft.intent ?? call.intent,
      outcome: call.outcome,
      nextAction: draft.nextAction,
      keyDetails: draft.keyDetails,
      generatedBy: draft.generatedBy,
    });
  } else if (summary) {
    summary.outcome = call.outcome;
    await summary.save();
  }
  if (summary) {
    call.summaryId = summary._id;
    if (summary.intent && summary.intent !== "unknown") call.intent = mergeIntent(call.intent as Intent, summary.intent as Intent);
  }

  await call.save();
  publish(call.businessId, "call.updated", { id: String(call._id) });
  return call;
}
