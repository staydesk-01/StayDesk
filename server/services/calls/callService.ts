import type { Types } from "mongoose";
import {
  Business,
  Call,
  CallSummary,
  CallTranscript,
  FollowUp,
  Opportunity,
  PaymentApproval,
  Reservation,
  ServiceRequest,
} from "../../models";
import type { CallDoc, CallProvider, CallStatus, Intent, Outcome, RoutingReason } from "../../models";
import { ACTIONABLE_INTENTS, mergeIntent } from "../ai/intent";
import { notify } from "../notifications/notificationService";
import { publish } from "../realtime";
import { redactSensitive } from "../safety/sensitive";
import { generateSummary } from "./summaryService";
import { buildCompletion } from "./completion";
import { flags } from "../../config/flags";
import { logger } from "../../config/logger";
import { recordInteraction } from "../memory/customerMemory";

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
  extra: { latencyMs?: number; id?: string; replyTo?: string } = {},
) {
  if (!text.trim()) return;
  text = redactSensitive(text); // card / ID numbers never reach the database
  const segment = { role, text: text.trim(), at: new Date(), ...(extra.latencyMs != null ? { latencyMs: extra.latencyMs } : {}), ...(extra.id ? { id: extra.id } : {}), ...(extra.replyTo ? { replyTo: extra.replyTo } : {}) };
  let transcript;
  if (extra.id) {
    // A segment id is stored once: appending the same id again is a no-op.
    await CallTranscript.updateOne({ callId: call._id, businessId: call.businessId }, { $setOnInsert: { callId: call._id, businessId: call.businessId } }, { upsert: true }).catch((e) => {
      if ((e as { code?: number }).code !== 11000) throw e;
    });
    transcript =
      (await CallTranscript.findOneAndUpdate({ callId: call._id, businessId: call.businessId, "segments.id": { $ne: extra.id } }, { $push: { segments: segment } }, { returnDocument: "after" })) ??
      (await CallTranscript.findOne({ callId: call._id, businessId: call.businessId }));
  } else {
    transcript = await CallTranscript.findOneAndUpdate(
      { callId: call._id, businessId: call.businessId },
      { $push: { segments: segment }, $setOnInsert: { callId: call._id, businessId: call.businessId } },
      { upsert: true, returnDocument: "after" },
    );
  }
  if (transcript) await Call.updateOne({ _id: call._id, transcriptId: { $exists: false } }, { $set: { transcriptId: transcript._id } });
  publish(call.businessId, "call.updated", { id: String(call._id) });
}

export async function recordAction(callId: Types.ObjectId, tool: string, ok: boolean, summary: string, incomplete = false) {
  await Call.updateOne({ _id: callId }, { $push: { actions: { tool, at: new Date(), ok, ...(incomplete ? { incomplete: true } : {}), summary: summary.slice(0, 300) } } });
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
  reservations: number;
}): Outcome {
  if (c.status === "abandoned") return "abandoned";
  if (c.status === "failed") return "failed";
  if (c.transferStatus === "answered") return "transferred";
  if (c.reservations) return "reservation_confirmed";
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

  const [transcript, opportunities, serviceRequests, followUps, business, reservations, payments] = await Promise.all([
    CallTranscript.findOne({ callId: call._id }),
    Opportunity.countDocuments({ callId: call._id }),
    ServiceRequest.countDocuments({ callId: call._id }),
    FollowUp.countDocuments({ callId: call._id }),
    Business.findById(call.businessId),
    Reservation.countDocuments({ callId: call._id, status: { $in: ["confirmed", "modified"] } }),
    PaymentApproval.countDocuments({ callId: call._id }),
  ]);
  const callerTurns = transcript?.segments.filter((s) => s.role === "caller").length ?? 0;
  const unfinished = (call.agentState as { wf?: { kind: string; slots?: Record<string, unknown>; confirming?: boolean } } | undefined)?.wf;
  const toolWork = call.actions.some((a) => a.ok && ["lookup_reservation", "modify_reservation", "cancel_reservation"].includes(a.tool ?? ""));
  const anyAction = toolWork || opportunities + serviceRequests + followUps + reservations + payments > 0 || call.transferStatus === "answered" || !!unfinished;

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
  if (aiInvolved && unfinished && status !== "abandoned") {
    // The call ended (customer hung up / line dropped) in the middle of a multi-step request. Keep what we captured.
    const s = (unfinished.slots ?? {}) as Record<string, unknown>;
    const captured = Object.entries({ name: s.name, "check-in": s.checkIn, "check-out": s.checkOut, guests: s.guests, room: s.roomType, "reservation code": s.code }).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ");
    await FollowUp.create({
      businessId: call.businessId,
      callId: call._id,
      customerName: call.callerName || (s.name as string) || "",
      phone: call.callerNumber,
      reason: `The call ended before the ${unfinished.kind} request was finished, so NOTHING was confirmed to the caller.${captured ? ` Captured so far: ${captured}.` : ""} Please call them back.`,
      priority: "high",
      dueAt: new Date(Date.now() + 3 * 3600_000),
      isDemo: call.isDemo,
    });
    createdFollowUps += 1;
  }
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
    reservations,
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

  // Call-to-completion record and caller memory: additive, and never allowed to break call finalisation.
  if (flags.completionTracking()) {
    try {
      call.completion = await buildCompletion(call, status);
    } catch (e) {
      logger.error("Could not build the completion record", { callId: String(call._id), message: (e as Error).message });
    }
  }
  await call.save();
  if (aiInvolved && business) {
    try {
      const completion = call.completion as { originalRequest?: string; nextSteps?: string[] } | undefined;
      await recordInteraction({
        businessId: call.businessId, business, callId: call._id, callerNumber: call.callerNumber, callerName: call.callerName || undefined,
        intent: call.intent, outcome: call.outcome, request: completion?.originalRequest, nextStep: completion?.nextSteps?.[0],
        language: (call.agentState as { voice?: { language?: string } } | undefined)?.voice?.language, isDemo: call.isDemo,
      });
    } catch (e) {
      logger.error("Could not update caller memory", { callId: String(call._id), message: (e as Error).message });
    }
  }
  publish(call.businessId, "call.updated", { id: String(call._id) });
  return call;
}
