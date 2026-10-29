import { BusinessPhoneNumber, FollowUp, OutboundConsent, Reservation, SuppressionEntry } from "../../models";
import type { BusinessDoc } from "../../models";
import { flags } from "../../config/flags";
import { normalizePhone } from "../../utils/phone";

/**
 * Decides whether StayDesk may place ONE automated call. Everything is denied unless every rule passes, and every
 * denial says why. This encodes StayDesk's own conservative defaults: it is NOT legal advice, and laws differ by
 * country and state (consent, calling hours, caller-ID, AI-voice disclosure). The business remains responsible for
 * compliance; the owner records their jurisdiction note and decides which purposes to approve.
 */
export interface OutboundCandidate {
  businessId: BusinessDoc["_id"];
  purpose: string;
  toNumber: string;
  callerIdNumber: string;
  recipientTimezone?: string;
  reservationId?: unknown;
  followUpId?: unknown;
  approvedBy?: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface Decision {
  allowed: boolean;
  reasons: string[];
  /** When the only problem is timing, the next moment it would be allowed (UTC). */
  retryAt?: Date;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const HARD_OPEN = 8 * 60;
const HARD_CLOSE = 21 * 60;
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + (m || 0); };

/** Minutes since local midnight in `tz` at `at`. */
export function localMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
}

const validTz = (tz?: string) => { try { if (!tz) return false; new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

export function withinCallingHours(at: Date, tz: string, start: string, end: string): boolean {
  const lo = Math.max(toMin(start), HARD_OPEN);
  const hi = Math.min(toMin(end), HARD_CLOSE);
  const now = localMinutes(at, tz);
  return now >= lo && now < hi;
}

/** Next instant (within 48 h) at which `withinCallingHours` becomes true. */
export function nextWindowStart(from: Date, tz: string, start: string, end: string): Date {
  for (let mins = 0; mins <= 48 * 60; mins += 15) {
    const t = new Date(from.getTime() + mins * 60_000);
    if (withinCallingHours(t, tz, start, end)) return t;
  }
  return new Date(from.getTime() + 24 * 3600_000);
}

export async function evaluateOutbound(business: BusinessDoc, c: OutboundCandidate, now = new Date()): Promise<Decision> {
  const reasons: string[] = [];
  const to = normalizePhone(c.toNumber);
  const caller = normalizePhone(c.callerIdNumber);

  if (!flags.outboundCalling()) reasons.push("Outbound calling is switched off for this deployment.");
  if (!business.outbound?.enabled) reasons.push("Outbound calling is not enabled for this business.");
  if (!(business.outbound?.purposes ?? []).includes(c.purpose)) reasons.push(`The purpose "${c.purpose}" has not been approved by the business.`);
  if (!E164.test(to)) reasons.push("The recipient number is not a valid international number.");

  // Do-not-call: absolute, checked first among data rules, no override.
  if (E164.test(to) && (await SuppressionEntry.exists({ businessId: c.businessId, phone: to }))) reasons.push("The recipient is on the do-not-call list.");

  // Basis for contacting this person: consent record, or (for the two customer-initiated purposes) the customer's own request.
  if (E164.test(to)) {
    const consent = await OutboundConsent.findOne({ businessId: c.businessId, phone: to, purpose: c.purpose as never, revokedAt: { $exists: false } });
    let basis = !!consent;
    if (!basis && c.purpose === "reservation_reminder" && c.reservationId) {
      const r = await Reservation.findOne({ _id: c.reservationId, businessId: c.businessId, status: { $in: ["confirmed", "modified"] } });
      basis = !!r && normalizePhone(r.guestPhone) === to; // the guest gave this number for their own booking
    }
    if (!basis && c.purpose === "customer_callback" && c.followUpId) {
      const f = await FollowUp.findOne({ _id: c.followUpId, businessId: c.businessId });
      basis = !!f && normalizePhone(f.phone) === to; // the customer asked to be called back on this number
    }
    if (!basis) reasons.push("There is no recorded consent or customer request for calling this number for this purpose.");
    if (c.purpose === "approved_follow_up" && !c.approvedBy) reasons.push("This follow-up call has not been approved by a staff member.");
  }

  // Caller ID: only a verified number the business controls.
  const id = E164.test(caller) ? await BusinessPhoneNumber.findOne({ businessId: c.businessId, e164: caller, "verification.status": "verified", callerIdAuthorized: true, role: { $in: ["outbound_caller_id", "both"] } }) : null;
  if (!id) reasons.push("The caller ID is not a verified number authorised for outbound calls on this account.");

  if (c.attempts >= c.maxAttempts) reasons.push("The maximum number of attempts has been reached.");

  // Calling hours at the recipient's local time (their timezone if known, otherwise the business's, which is the safer assumption).
  let retryAt: Date | undefined;
  const tz = validTz(c.recipientTimezone) ? c.recipientTimezone! : business.timezone;
  const { windowStart = "09:00", windowEnd = "20:00" } = business.outbound ?? {};
  if (!withinCallingHours(now, tz, windowStart, windowEnd)) {
    reasons.push("It is outside the permitted calling hours for the recipient.");
    retryAt = nextWindowStart(now, tz, windowStart, windowEnd);
  }

  // Timing is the only retryable reason; everything else needs a human to change something.
  const onlyTiming = reasons.length === 1 && !!retryAt;
  return { allowed: reasons.length === 0, reasons, retryAt: onlyTiming ? retryAt : undefined };
}
