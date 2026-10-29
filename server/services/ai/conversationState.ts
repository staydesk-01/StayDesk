import type { CallDoc } from "../../models";

/**
 * What the conversation currently knows, derived from the stored call: the facts the caller has given, the status of
 * any booking, and what is still pending. This is memory; the workflow step that is active right now is separate
 * (`agentState.wf` / `agentState.awaiting`), so a side question never erases what was already provided.
 */
export type BookingStatus =
  | "none"
  | "collecting"
  | "awaiting_confirmation"
  | "inquiry_received"
  | "reservation_confirmed"
  | "approval_pending"
  | "follow_up_created"
  | "failed";

export interface ConversationFacts {
  intent: string;
  name?: string;
  roomType?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  request?: string;
  bookingStatus: BookingStatus;
  /** The question the agent is waiting on right now, if any. */
  pendingQuestion?: string;
  /** Caller questions the agent could not verify (queued for staff once). */
  unverifiedQuestion: boolean;
  completedTasks: string[];
}

interface StateShape {
  wf?: { kind: string; asked?: string; confirming?: boolean; slots?: Record<string, unknown> };
  flow?: string;
  awaiting?: string;
  slots?: { name?: string; details?: string };
  unverifiedNoted?: boolean;
}

export function deriveFacts(call: Pick<CallDoc, "agentState" | "actions" | "intent" | "callerName">): ConversationFacts {
  const st = (call.agentState ?? {}) as StateShape;
  const wf = st.wf;
  const ws = (wf?.slots ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const ok = (tool: string) => call.actions.some((a) => a.tool === tool && a.ok && !a.incomplete);
  const failed = (tool: string) => call.actions.some((a) => a.tool === tool && !a.ok);

  const completedTasks: string[] = [];
  if (ok("create_reservation")) completedTasks.push("reservation_confirmed");
  if (ok("create_booking_or_lead")) completedTasks.push("inquiry_received");
  if (ok("request_payment_approval")) completedTasks.push("payment_approval_requested");
  if (ok("create_follow_up")) completedTasks.push("follow_up_created");

  let bookingStatus: BookingStatus = "none";
  if (wf?.kind === "reserve") bookingStatus = wf.confirming ? "awaiting_confirmation" : "collecting";
  else if (ok("create_reservation")) bookingStatus = "reservation_confirmed";
  else if (ok("request_payment_approval")) bookingStatus = "approval_pending";
  else if (ok("create_booking_or_lead")) bookingStatus = "inquiry_received";
  else if ((st.flow === "booking" || st.flow === "appointment") && st.awaiting) bookingStatus = "collecting";
  else if (failed("create_reservation") || failed("create_booking_or_lead")) bookingStatus = "failed";
  else if (ok("create_follow_up")) bookingStatus = "follow_up_created";

  return {
    intent: call.intent,
    name: str(ws.name) ?? str(st.slots?.name) ?? (call.callerName || undefined),
    roomType: str(ws.roomType),
    checkIn: str(ws.checkIn),
    checkOut: str(ws.checkOut),
    guests: typeof ws.guests === "number" ? ws.guests : undefined,
    request: str(st.slots?.details),
    bookingStatus,
    pendingQuestion: wf?.asked ?? st.awaiting,
    unverifiedQuestion: !!st.unverifiedNoted || !!(wf as { unansweredQuestion?: boolean } | undefined)?.unansweredQuestion,
    completedTasks,
  };
}
