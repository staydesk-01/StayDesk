import { Business, Call, FollowUp, PhoneConfiguration } from "../../models";
import type { CallDoc } from "../../models";
import { notify } from "../notifications/notificationService";
import { publish } from "../realtime";
import { resolveHumanNumber } from "../business/businessService";
import { appendTranscript } from "./callService";

export type TransferStart =
  | { status: "connecting"; number: string }
  | { status: "unavailable"; reason: string };

/**
 * Begins a warm transfer. For real calls this only records intent (transferStatus=ringing, pendingTransfer=true);
 * the telephony layer then dials the number and reports the result to completeTransfer().
 */
export async function startTransfer(call: CallDoc, reason: string): Promise<TransferStart> {
  const [business, config] = await Promise.all([
    Business.findById(call.businessId),
    PhoneConfiguration.findOne({ businessId: call.businessId }),
  ]);
  const number = business && config ? resolveHumanNumber(business, config) : "";

  call.transferAttempted = true;
  const startedAt = new Date();
  if (!number) {
    call.transferStatus = "failed";
    call.transfer = { ...(call.transfer ?? {}), attempts: [...(call.transfer?.attempts ?? []), { startedAt, number: "", status: "failed", reason: "No escalation number configured" }] } as CallDoc["transfer"];
    await call.save();
    await afterFailedTransfer(call, "No human transfer number is configured.");
    return { status: "unavailable", reason: "No escalation number configured" };
  }

  call.transferStatus = "ringing";
  call.pendingTransfer = call.provider !== "simulator";
  call.transfer = {
    transferStartedAt: startedAt,
    transferNumber: number,
    attempts: [...(call.transfer?.attempts ?? []), { startedAt, number, status: "ringing", reason }],
  } as CallDoc["transfer"];
  await call.save();
  await appendTranscript(call, "system", `Transferring caller to staff (${number})…`);
  publish(call.businessId, "call.updated", { id: String(call._id) });
  return { status: "connecting", number };
}

/** Records the outcome of a transfer attempt. On failure: follow-up + owner alert; the AI then resumes helping. */
export async function completeTransfer(callId: CallDoc["_id"], result: { answered: boolean; failure?: "no_answer" | "failed" }) {
  const call = await Call.findById(callId);
  if (!call) return null;

  const attempts = call.transfer?.attempts ?? [];
  const last = attempts[attempts.length - 1];
  const now = new Date();
  if (last) {
    last.status = result.answered ? "answered" : (result.failure ?? "no_answer");
    if (result.answered) last.answeredAt = now;
  }
  call.pendingTransfer = false;

  if (result.answered) {
    call.transferStatus = "answered";
    if (call.transfer) call.transfer.transferAnsweredAt = now;
    call.handledBy = "ai_and_human";
    call.status = "human_transferred";
    await call.save();
    await appendTranscript(call, "system", "Staff member answered. Call bridged to a human.");
  } else {
    call.transferStatus = result.failure ?? "no_answer";
    await call.save();
    await appendTranscript(call, "system", "Nobody answered the transfer. AI resumed the conversation.");
    await afterFailedTransfer(call, "Nobody on the team answered the transfer.");
  }
  publish(call.businessId, "call.updated", { id: String(call._id) });
  return call;
}

async function afterFailedTransfer(call: CallDoc, why: string) {
  const alreadyHasFollowUp = await FollowUp.exists({ callId: call._id, priority: { $in: ["high", "urgent"] } });
  if (!alreadyHasFollowUp) {
    await FollowUp.create({
      businessId: call.businessId,
      callId: call._id,
      customerName: call.callerName,
      phone: call.callerNumber,
      reason: `Caller asked to speak with a person. ${why} Please call them back.`,
      priority: "high",
      dueAt: new Date(Date.now() + 2 * 3600_000),
      isDemo: call.isDemo,
    });
    await Call.updateOne({ _id: call._id }, { $set: { followUpRequired: true } });
  }
  await notify({
    businessId: call.businessId,
    type: "transfer_failed",
    title: "Human transfer failed",
    body: `${call.callerName || call.callerNumber || "A caller"} asked for a person and nobody answered. A follow-up was created.`,
    callId: call._id,
    isDemo: call.isDemo,
  });
}
