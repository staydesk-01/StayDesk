import type { Types } from "mongoose";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { Business, Call, FollowUp, OutboundCallRequest, SuppressionEntry, TelephonyConnection } from "../../models";
import type { ConnectionKind } from "../../models";
import { AppError } from "../../utils/errors";
import { normalizePhone } from "../../utils/phone";
import { createCallSession } from "../calls/callService";
import { runWithFailover } from "../telephony/core/breaker";
import { effectiveStatus } from "../telephony/core/health";
import { getAdapter, loadContext } from "../telephony/core/registry";
import { evaluateOutbound } from "./policy";

const base = () => env.PUBLIC_BASE_URL.replace(/\/$/, "");
/** Preference when several outbound-capable connections are healthy: own gateway first, then Twilio, then Vapi. */
const KIND_PRIORITY: ConnectionKind[] = ["sip_gateway", "twilio", "vapi"];

const audit = (event: string, detail = "") => ({ at: new Date(), event, detail: detail.slice(0, 300) });

export interface RequestInput {
  businessId: Types.ObjectId;
  idempotencyKey: string;
  purpose: "reservation_reminder" | "customer_callback" | "order_status" | "approved_follow_up";
  toNumber: string;
  callerIdNumber: string;
  recipientName?: string;
  recipientTimezone?: string;
  message?: string;
  reservationId?: Types.ObjectId;
  followUpId?: Types.ObjectId;
  requestedBy: string;
  approvedBy?: Types.ObjectId;
}

/**
 * Records a request to call someone. Idempotent on (business, idempotencyKey). The compliance policy runs now, and
 * AGAIN at dial time, because consent can be withdrawn or the clock can move outside the permitted hours in between.
 */
export async function requestOutbound(input: RequestInput, now = new Date()) {
  const existing = await OutboundCallRequest.findOne({ businessId: input.businessId, idempotencyKey: input.idempotencyKey });
  if (existing) return { request: existing, duplicate: true };

  const business = await Business.findById(input.businessId);
  if (!business) throw AppError.notFound("Business not found");
  const to = normalizePhone(input.toNumber);
  const maxAttempts = business.outbound?.maxAttempts ?? 2;
  const decision = await evaluateOutbound(business, { ...input, toNumber: to, attempts: 0, maxAttempts }, now);

  const doc = {
    businessId: input.businessId, idempotencyKey: input.idempotencyKey, purpose: input.purpose, toNumber: to, recipientName: input.recipientName ?? "",
    recipientTimezone: input.recipientTimezone ?? "", callerIdNumber: normalizePhone(input.callerIdNumber), message: (input.message ?? "").slice(0, 500),
    reservationId: input.reservationId, followUpId: input.followUpId, requestedBy: input.requestedBy, approvedBy: input.approvedBy, approvedAt: input.approvedBy ? new Date() : undefined, maxAttempts,
  };
  try {
    if (decision.allowed || decision.retryAt) {
      const request = await OutboundCallRequest.create({ ...doc, status: "scheduled", nextAttemptAt: decision.retryAt ?? now, audit: [audit("requested", input.requestedBy), audit(decision.retryAt ? "deferred" : "approved_by_policy", decision.retryAt ? `outside calling hours; earliest ${decision.retryAt.toISOString()}` : "")] });
      return { request, duplicate: false };
    }
    const request = await OutboundCallRequest.create({ ...doc, status: "blocked", blockedReason: decision.reasons.join(" "), audit: [audit("requested", input.requestedBy), audit("blocked", decision.reasons.join(" "))] });
    return { request, duplicate: false };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return { request: (await OutboundCallRequest.findOne({ businessId: input.businessId, idempotencyKey: input.idempotencyKey }))!, duplicate: true };
    throw e;
  }
}

export async function cancelOutbound(businessId: Types.ObjectId, id: string, by: string) {
  const r = await OutboundCallRequest.findOneAndUpdate(
    { _id: id, businessId, status: { $in: ["pending", "scheduled"] } },
    { $set: { status: "cancelled" }, $push: { audit: audit("cancelled", by) } },
    { returnDocument: "after" },
  );
  if (!r) throw AppError.conflict("This request can no longer be cancelled.");
  return r;
}

/** Outbound-capable connections that are usable now, best first. */
async function usableKinds(businessId: Types.ObjectId): Promise<ConnectionKind[]> {
  const conns = await TelephonyConnection.find({ businessId, kind: { $in: KIND_PRIORITY } });
  return KIND_PRIORITY.filter((k) => {
    const c = conns.find((x) => x.kind === k);
    if (!c || !getAdapter(k).capabilities.outbound) return false;
    const s = effectiveStatus(c).status;
    return s === "connected" || s === "degraded";
  });
}

/**
 * Dials requests that are due. Each is claimed atomically (scheduled → dialing, attempts + 1) so two workers can never
 * place the same call. Returns what happened, for logging and tests.
 */
export async function dispatchDue(now = new Date(), limit = 20): Promise<{ id: string; outcome: string }[]> {
  const out: { id: string; outcome: string }[] = [];
  for (let i = 0; i < limit; i++) {
    const req = await OutboundCallRequest.findOneAndUpdate(
      { status: "scheduled", nextAttemptAt: { $lte: now } },
      { $set: { status: "dialing" }, $inc: { attempts: 1 }, $push: { audit: audit("claimed") } },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
    );
    if (!req) break;
    out.push({ id: String(req._id), outcome: await dialOne(req._id, now) });
  }
  return out;
}

async function dialOne(id: Types.ObjectId, now: Date): Promise<string> {
  const req = (await OutboundCallRequest.findById(id))!;
  const business = await Business.findById(req.businessId);
  if (!business) return fail(req, "blocked", "Business no longer exists");

  // Re-check policy at dial time. The attempt just claimed is counted, so compare against attempts - 1.
  const decision = await evaluateOutbound(business, { ...req.toObject(), attempts: req.attempts - 1 } as never, now);
  if (!decision.allowed) {
    if (decision.retryAt) {
      await OutboundCallRequest.updateOne({ _id: id }, { $set: { status: "scheduled", nextAttemptAt: decision.retryAt }, $inc: { attempts: -1 }, $push: { audit: audit("deferred", decision.reasons.join(" ")) } });
      return "deferred";
    }
    return fail(req, "blocked", decision.reasons.join(" "));
  }

  const kinds = await usableKinds(req.businessId);
  const call = await createCallSession({
    businessId: req.businessId, provider: "twilio", providerCallId: `pending-${req._id}-${req.attempts}`, callerNumber: req.toNumber, businessNumber: req.callerIdNumber,
    routingReason: "direct_ai", handledBy: "ai", status: "ringing",
  });
  await Call.updateOne({ _id: call._id }, { $set: { direction: "outbound" } });

  try {
    // Breaker keys are per tenant ("twilio:<businessId>"): one business's bad credentials must not disable calling for others.
    const placed = await runWithFailover(kinds.map((k) => `${k}:${req.businessId}`), async (name) => {
      const kind = name.split(":")[0] as ConnectionKind;
      const { ctx } = await loadContext(req.businessId, kind);
      const { providerCallId } = await getAdapter(kind).startOutbound(ctx, {
        from: req.callerIdNumber, to: req.toNumber, callId: String(call._id),
        answerUrl: `${base()}/api/twilio/outbound?callId=${call._id}&requestId=${req._id}`, statusCallbackUrl: `${base()}/api/twilio/status`,
      });
      return { kind, providerCallId };
    });
    const provider = placed.value.kind === "sip_gateway" ? "sip" : placed.value.kind === "vapi" ? "vapi" : "twilio";
    await Call.updateOne({ _id: call._id }, { $set: { provider, providerCallId: placed.value.providerCallId } });
    await OutboundCallRequest.updateOne({ _id: id }, { $set: { callId: call._id }, $push: { audit: audit("dialing", `${placed.value.kind}${placed.failed.length ? ` after ${placed.failed.map((f) => f.provider).join(", ")} failed` : ""}`) } });
    return "dialing";
  } catch (e) {
    await Call.deleteOne({ _id: call._id, endedAt: null, "actions.0": { $exists: false } });
    logger.warn("Outbound call could not be placed", { requestId: String(id), message: (e as Error).message });
    return retryOrExhaust(req, (e as Error).message);
  }
}

async function fail(req: { _id: Types.ObjectId }, status: "blocked" | "failed", reason: string) {
  await OutboundCallRequest.updateOne({ _id: req._id }, { $set: { status, blockedReason: status === "blocked" ? reason : "", lastError: status === "failed" ? reason : "" }, $push: { audit: audit(status, reason) } });
  return status;
}

/** Network or provider problems and unanswered calls are retried within the attempt limit; then staff are told. */
async function retryOrExhaust(req: { _id: Types.ObjectId; businessId: Types.ObjectId; attempts: number; maxAttempts: number; toNumber: string; recipientName?: string | null; purpose: string }, error: string) {
  if (req.attempts < req.maxAttempts) {
    const business = await Business.findById(req.businessId).select("outbound");
    const next = new Date(Date.now() + (business?.outbound?.retryMinutes ?? 120) * 60_000);
    await OutboundCallRequest.updateOne({ _id: req._id }, { $set: { status: "scheduled", nextAttemptAt: next, lastError: error.slice(0, 300) }, $push: { audit: audit("retry_scheduled", `${error}; next ${next.toISOString()}`) } });
    return "retry";
  }
  await OutboundCallRequest.updateOne({ _id: req._id }, { $set: { status: "exhausted", lastError: error.slice(0, 300) }, $push: { audit: audit("exhausted", error) } });
  await FollowUp.create({
    businessId: req.businessId, phone: req.toNumber, customerName: req.recipientName ?? "", priority: "normal", dueAt: new Date(Date.now() + 4 * 3600_000),
    reason: `An automatic ${req.purpose.replace(/_/g, " ")} call could not be completed after ${req.attempts} attempt(s) (${error}). Please contact them yourself.`,
  }).catch(() => undefined);
  return "exhausted";
}

/** Called when the provider reports the end of an outbound call. */
export async function onOutboundCallEnded(callId: Types.ObjectId, providerStatus: string) {
  const req = await OutboundCallRequest.findOne({ callId });
  if (!req || req.status !== "dialing") return;
  if (providerStatus === "completed") {
    await OutboundCallRequest.updateOne({ _id: req._id }, { $set: { status: "completed" }, $push: { audit: audit("completed") } });
    return;
  }
  // busy / no-answer / failed: an unanswered call counts as an attempt and may be retried within limits.
  await retryOrExhaust(req, `Call ended: ${providerStatus}`);
}

/** The person asked not to be called again, on the call itself. Takes effect immediately and permanently. */
export async function recordOptOut(businessId: Types.ObjectId, phone: string, note: string) {
  const p = normalizePhone(phone);
  await SuppressionEntry.updateOne({ businessId, phone: p }, { $setOnInsert: { businessId, phone: p, reason: "opt_out_on_call", note: note.slice(0, 200) } }, { upsert: true });
  await OutboundCallRequest.updateMany({ businessId, toNumber: p, status: { $in: ["pending", "scheduled"] } }, { $set: { status: "cancelled", blockedReason: "Recipient opted out" }, $push: { audit: audit("cancelled", "recipient opted out") } });
}

export const OPT_OUT = /\b(stop (calling|call)|don'?t call( me)?( again)?|do not call|remove (me|my number)|take me off|unsubscribe|never call)\b/i;
