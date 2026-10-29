import { CallTranscript, FollowUp, Opportunity, PaymentApproval, Reservation, ServiceRequest } from "../../models";
import type { CallDoc } from "../../models";
import { redactSensitive } from "../safety/sensitive";

/**
 * Call-to-completion record: what the caller originally asked for, what the agent tried, what ACTUALLY happened in the
 * business systems, what failed, and what a human still has to do. Built from stored facts (tool audit trail and
 * the records the call created), never from what the agent said.
 */
export type CompletionStatus = "fulfilled" | "answered" | "needs_follow_up" | "handed_to_human" | "abandoned" | "failed";

export interface CompletionRecord {
  originalRequest: string;
  intent: string;
  attempted: { tool: string; at: Date; result: "success" | "failed" | "incomplete"; detail: string }[];
  outcomes: { type: "reservation" | "payment_approval" | "follow_up" | "service_request" | "opportunity" | "transfer"; ref: string; status: string; detail?: string }[];
  failures: string[];
  nextSteps: string[];
  status: CompletionStatus;
  builtAt: Date;
}

const INFO_ONLY = new Set(["general_question", "business_hours", "pricing_question", "location_question"]);
const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening)|yes|yeah|okay|ok)[.!, ]*$/i;

/** The caller's first real request: the first caller line that is more than a greeting. */
export function pickOriginalRequest(segments: { role: string; text: string }[]): string {
  const caller = segments.filter((s) => s.role === "caller").map((s) => s.text.trim());
  const first = caller.find((t) => t.split(/\s+/).length >= 3 && !GREETING.test(t)) ?? caller[0] ?? "";
  return redactSensitive(first).slice(0, 240);
}

export async function buildCompletion(call: CallDoc, status: string): Promise<CompletionRecord> {
  const [transcript, reservations, approvals, followUps, requests, opportunities] = await Promise.all([
    CallTranscript.findOne({ callId: call._id }),
    Reservation.find({ callId: call._id }),
    PaymentApproval.find({ callId: call._id }),
    FollowUp.find({ callId: call._id }),
    ServiceRequest.find({ callId: call._id }),
    Opportunity.find({ callId: call._id }),
  ]);

  const attempted = call.actions.map((a) => ({
    tool: a.tool ?? "",
    at: a.at ?? new Date(),
    result: (a.incomplete ? "incomplete" : a.ok ? "success" : "failed") as "success" | "failed" | "incomplete",
    detail: a.summary ?? "",
  }));

  const outcomes: CompletionRecord["outcomes"] = [
    ...reservations.map((r) => ({ type: "reservation" as const, ref: r.confirmationCode, status: r.status })),
    ...approvals.map((a) => ({ type: "payment_approval" as const, ref: String(a._id), status: a.status, detail: `${a.kind}${a.amount != null ? ` $${a.amount}` : ""}` })),
    ...requests.map((r) => ({ type: "service_request" as const, ref: String(r._id), status: r.status, detail: r.description })),
    ...opportunities.map((o) => ({ type: "opportunity" as const, ref: String(o._id), status: o.status })),
    ...followUps.map((f) => ({ type: "follow_up" as const, ref: String(f._id), status: f.status, detail: f.reason.slice(0, 160) })),
    ...(call.transferStatus !== "none" ? [{ type: "transfer" as const, ref: String(call._id), status: call.transferStatus }] : []),
  ];

  const failures = attempted.filter((a) => a.result !== "success").map((a) => `${a.tool}: ${a.detail}`);
  if (call.metrics?.brainErrors) failures.push(`The AI model failed ${call.metrics.brainErrors} time(s); the built-in fallback answered.`);
  const recovered = call.voice?.recoveredErrors ?? 0;
  if (recovered > 0) failures.push(`${recovered} turn(s) hit an unexpected error and were recovered.`);

  const unfinished = (call.agentState as { wf?: { kind: string } } | undefined)?.wf;
  const nextSteps: string[] = [];
  for (const a of approvals) if (a.status === "pending") nextSteps.push(`Staff approval needed: ${a.kind}${a.amount != null ? ` of $${a.amount}` : ""}.`);
  for (const f of followUps) if (f.status === "open" || f.status === "in_progress") nextSteps.push(f.reason.slice(0, 200));
  if (unfinished) nextSteps.push(`The ${unfinished.kind} request was not finished: nothing was confirmed to the caller.`);

  const done = reservations.some((r) => r.status === "confirmed" || r.status === "modified") || requests.length > 0 || opportunities.length > 0 || attempted.some((a) => a.result === "success" && ["modify_reservation", "cancel_reservation"].includes(a.tool));
  const intent = call.intent as string;

  let result: CompletionStatus;
  if (status === "abandoned") result = "abandoned";
  else if (status === "failed") result = "failed";
  else if (call.transferStatus === "answered") result = "handed_to_human";
  else if (nextSteps.length) result = "needs_follow_up";
  else if (done) result = "fulfilled"; // something was achieved; any failures are listed separately
  else if (INFO_ONLY.has(intent) || intent === "unknown" || attempted.length === 0) result = "answered";
  else result = "needs_follow_up";

  return {
    originalRequest: pickOriginalRequest(transcript?.segments ?? []),
    intent,
    attempted,
    outcomes,
    failures,
    nextSteps,
    status: result,
    builtAt: new Date(),
  };
}
