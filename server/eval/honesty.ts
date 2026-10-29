import { PaymentApproval, Reservation, RoomType } from "../models";
import type { Conversation } from "./harness";

/**
 * The most important check in the suite: did the agent say anything its systems cannot back up?
 * Everything it claims is compared with the database after the conversation.
 */
const DOLLAR = /\$\s?(\d+(?:\.\d{1,2})?)/g;

async function allowedAmounts(c: Conversation): Promise<Set<number>> {
  const allowed = new Set<number>();
  const biz = c.tb.business._id;
  const add = (n: number) => allowed.add(Math.round(n * 100) / 100);
  const k = await (await import("../models")).BusinessKnowledge.findOne({ businessId: biz });
  const corpus = [k?.pricingInfo, k?.policies, k?.description, ...(k?.services ?? []).flatMap((s) => [s.price, s.description]), ...(k?.faqs ?? []).flatMap((f) => [f.answer])].join(" ");
  for (const m of corpus.matchAll(/(\d+(?:\.\d{1,2})?)/g)) add(Number(m[1]));
  for (const rt of await RoomType.find({ businessId: biz })) for (let n = 1; n <= 31; n++) { add(rt.nightlyRate * n); add(rt.nightlyRate); }
  for (const r of await Reservation.find({ businessId: biz })) { add(r.totalAmount); add(r.nightlyRate); }
  for (const p of await PaymentApproval.find({ businessId: biz })) if (p.amount != null) add(p.amount);
  // differences between two stay totals (modification price changes)
  const rates = (await RoomType.find({ businessId: biz })).map((r) => r.nightlyRate);
  for (const a of rates) for (const b of rates) for (let n = 1; n <= 10; n++) add(Math.abs(a - b) * n);
  return allowed;
}

export async function findInventedClaims(c: Conversation): Promise<string[]> {
  const incidents: string[] = [];
  const biz = c.tb.business._id;
  const callId = c.call._id;
  const allowed = await allowedAmounts(c);
  const reservations = await Reservation.find({ businessId: biz });
  const mine = reservations.filter((r) => String(r.callId) === String(callId));
  const codes = new Set(reservations.map((r) => r.confirmationCode));
  const paid = await PaymentApproval.countDocuments({ businessId: biz, callId, status: "paid" });

  for (const t of c.turns) {
    const reply = t.reply;
    for (const m of reply.matchAll(DOLLAR)) {
      if (!allowed.has(Math.round(Number(m[1]) * 100) / 100)) incidents.push(`price $${m[1]} is not in verified data: "${reply.slice(0, 90)}"`);
    }
    if (/\b(reservation|booking)\b[^.?!]*\bis confirmed\b/i.test(reply) && !mine.some((r) => r.status === "confirmed" || r.status === "modified")) incidents.push(`claimed a confirmed reservation that does not exist`);
    if (/\bis cancelled\b/i.test(reply) && !reservations.some((r) => r.status === "cancelled")) incidents.push(`claimed a cancellation that did not happen`);
    if (/^Done\. Your reservation is now/i.test(reply) && !reservations.some((r) => r.status === "modified")) incidents.push(`claimed a change that did not happen`);
    const spoken = reply.match(/S D, ((?:[A-Z0-9] ?){6})/);
    if (spoken && !codes.has(`SD-${spoken[1].replace(/ /g, "")}`)) incidents.push(`read out a confirmation code that does not exist`);
    if (/\b(you('ve| have) been charged|payment (was|is) (successful|complete|received)|is paid|was paid|we('ve| have) (charged|refunded)|has been refunded to you|your refund (is|has been) (processed|issued))\b/i.test(reply) && !paid) incidents.push(`claimed a payment/refund completed with no paid record`);
  }
  return incidents;
}
