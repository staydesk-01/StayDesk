import { Call, Opportunity, PaymentApproval } from "../models";
import { diffDays } from "../services/ai/dates";
import { BookingError, getBookingProvider, guestMatches } from "../services/booking";
import type { BookingProvider, ReservationRecord } from "../services/booking";
import { localDateKey } from "../services/calls/businessHours";
import { notify } from "../services/notifications/notificationService";
import { publish } from "../services/realtime";
import { normalizePhone } from "../utils/phone";
import { cancelReservationInput, createReservationInput, lookupReservationInput, modifyReservationInput } from "../validators/tools";
import { resolveRoom } from "./helpers";
import { defineTool, fail } from "./types";

const NO_SYSTEM = "No booking system is connected for this business, so reservations cannot be made or changed on this call. Take a booking inquiry or offer a callback instead.";
const view = (r: ReservationRecord) => ({
  confirmationCode: r.confirmationCode,
  guestName: r.guestName,
  roomType: r.roomTypeName,
  checkIn: r.checkIn,
  checkOut: r.checkOut,
  nights: r.nights,
  guests: r.guests,
  nightlyRate: r.nightlyRate,
  totalAmount: r.totalAmount,
  status: r.status,
});

/** The booking system must return exactly what we asked it to store, or we do not call it confirmed. */
function sameBooking(a: ReservationRecord, b: ReservationRecord | null) {
  return !!b && a.confirmationCode === b.confirmationCode && a.checkIn === b.checkIn && a.checkOut === b.checkOut && a.roomTypeId === b.roomTypeId && a.guests === b.guests && b.status !== "cancelled";
}

async function load(provider: BookingProvider, businessId: Parameters<BookingProvider["findReservation"]>[0], code: string, who: { phone?: string; lastName?: string }) {
  const rec = await provider.findReservation(businessId, code);
  if (!rec) return { rec: null, verified: false };
  return { rec, verified: guestMatches(rec, who) };
}

const NOT_VERIFIED = {
  done: false,
  reason: "identity_not_verified",
  message: "The confirmation code was found but the caller could not be verified. Ask for the last name on the reservation. Do not reveal any reservation details until verified.",
};
const NOT_FOUND = { done: false, reason: "not_found", message: "No reservation matches that confirmation code. Ask the caller to repeat it (codes look like SD-AB12CD), or offer a callback." };

export const createReservation = defineTool({
  name: "create_reservation",
  description:
    "Book a room in the connected booking system after you have: guest name, room type, check-in, check-out and number of guests, and have confirmed them with the caller. Only say the booking is confirmed if the result says confirmed=true and verified=true, and read out the confirmationCode from the result exactly. Never invent a code.",
  schema: createReservationInput,
  async handler({ businessId, call, business }, input) {
    const provider = await getBookingProvider(businessId);
    if (!provider) return fail("integration_unavailable", NO_SYSTEM);

    const today = localDateKey(new Date(), business.timezone);
    const nights = diffDays(input.checkIn, input.checkOut);
    if (nights < 1) return fail("invalid_dates", "Check-out must be after check-in.");
    if (input.checkIn < today) return fail("invalid_dates", "Check-in is in the past.");
    if (nights > 30) return fail("invalid_dates", "Stays over 30 nights need staff.");

    const options = await provider.listRoomTypes(businessId);
    const { match, ambiguous } = resolveRoom(options, input.roomType);
    if (!match) {
      return fail("room_type", ambiguous ? `Which room type? ${ambiguous.map((o) => o.name).join(", ")}.` : `No such room type. Offered: ${options.map((o) => o.name).join(", ")}.`);
    }

    let record: ReservationRecord;
    try {
      record = await provider.createReservation(businessId, {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        roomTypeId: match.roomTypeId,
        guestName: input.guestName,
        guestPhone: normalizePhone(input.guestPhone) || call.callerNumber,
        guestEmail: input.guestEmail,
        guests: input.guests,
        callId: call._id,
        isDemo: call.isDemo,
        source: call.provider === "simulator" ? "test" : "ai_call",
      });
    } catch (e) {
      if (e instanceof BookingError) {
        if (e.code === "unavailable") {
          const alternatives = (await provider.checkAvailability(businessId, { checkIn: input.checkIn, checkOut: input.checkOut, guests: input.guests })).filter((o) => o.available > 0);
          return {
            confirmed: false,
            reason: "unavailable",
            message: e.message,
            alternatives: alternatives.map((o) => ({ roomType: o.name, nightlyRate: o.nightlyRate, totalForStay: Math.round(o.nightlyRate * nights * 100) / 100 })),
          };
        }
        if (e.code === "invalid") return fail("invalid", e.message);
        if (e.code === "not_found") return fail("room_type", e.message);
      }
      return fail("integration_unavailable", "The booking system did not respond. Do not tell the caller anything was booked; offer a callback.");
    }

    // Read-back: the system of record must return what we just stored before we call it confirmed.
    const verifiedRecord = await provider.findReservation(businessId, record.confirmationCode).catch(() => null);
    if (!sameBooking(record, verifiedRecord)) {
      await provider.cancelReservation(businessId, record.confirmationCode).catch(() => undefined);
      return fail("verification_failed", "The booking could not be verified in the booking system, so it was not made. Offer a callback.");
    }

    await Call.updateOne({ _id: call._id, callerName: "" }, { $set: { callerName: input.guestName } });
    // Idempotency: a retried booking returns the same reservation and must not record the same sale twice.
    const alreadyRecorded = await Opportunity.exists({ businessId, callId: call._id, details: { $regex: record.confirmationCode } });
    if (!alreadyRecorded) await Opportunity.create({
      businessId,
      callId: call._id,
      type: "booking",
      customerName: input.guestName,
      customerPhone: record.guestPhone,
      details: `Confirmed reservation ${record.confirmationCode}: ${record.roomTypeName}, ${record.checkIn} to ${record.checkOut}, ${record.guests} guest(s)`,
      estimatedValue: record.totalAmount,
      status: "converted", // booked in the booking system; revenue stays UNVERIFIED until staff confirm payment
      isDemo: call.isDemo,
    });
    await notify({
      businessId,
      type: "booking_inquiry",
      title: `Reservation confirmed: ${record.guestName} (${record.confirmationCode})`,
      body: `${record.roomTypeName}, ${record.checkIn} to ${record.checkOut}, ${record.guests} guest(s), $${record.totalAmount}`,
      callId: call._id,
      isDemo: call.isDemo,
    });
    publish(businessId, "opportunity.updated", { id: record.confirmationCode });
    return { confirmed: true, verified: true, ...view(record), note: "No payment has been taken. Do not mention deposits or charges unless the business policy says so; any payment needs human approval." };
  },
});

export const modifyReservation = defineTool({
  name: "modify_reservation",
  description:
    "Change dates, room type or guests on an existing reservation. Needs the confirmation code and the caller's last name (or a phone number matching the reservation). Only say it changed if done=true. If the price changes, any extra charge or refund needs request_payment_approval; never promise either.",
  schema: modifyReservationInput,
  async handler({ businessId, call, business }, input) {
    const provider = await getBookingProvider(businessId);
    if (!provider) return fail("integration_unavailable", NO_SYSTEM);
    const found = await load(provider, businessId, input.confirmationCode, { phone: call.callerNumber, lastName: input.guestLastName });
    if (!found.rec) return NOT_FOUND;
    if (!found.verified) return NOT_VERIFIED;
    const before = found.rec;
    if (before.status === "cancelled") return { done: false, reason: "cancelled", message: "That reservation has been cancelled and cannot be changed." };

    const today = localDateKey(new Date(), business.timezone);
    const checkIn = input.newCheckIn ?? before.checkIn;
    const checkOut = input.newCheckOut ?? before.checkOut;
    if (checkIn < today) return fail("invalid_dates", "New check-in is in the past.");
    if (diffDays(checkIn, checkOut) < 1) return fail("invalid_dates", "Check-out must be after check-in.");

    let roomTypeId: string | undefined;
    if (input.newRoomType) {
      const { match, ambiguous } = resolveRoom(await provider.listRoomTypes(businessId), input.newRoomType);
      if (!match) return fail("room_type", ambiguous ? `Which room type? ${ambiguous.map((o) => o.name).join(", ")}.` : "No such room type.");
      roomTypeId = match.roomTypeId;
    }
    try {
      const after = await provider.modifyReservation(businessId, before.confirmationCode, { checkIn, checkOut, roomTypeId, guests: input.newGuests });
      const check = await provider.findReservation(businessId, after.confirmationCode).catch(() => null);
      if (!check || check.checkIn !== checkIn || check.checkOut !== checkOut || (roomTypeId && check.roomTypeId !== roomTypeId)) {
        return fail("verification_failed", "The change could not be verified in the booking system. Do not tell the caller it changed; offer a callback.");
      }
      const delta = Math.round((after.totalAmount - before.totalAmount) * 100) / 100;
      await notify({ businessId, type: "info", title: `Reservation changed: ${after.confirmationCode}`, body: `${before.checkIn}→${before.checkOut} is now ${after.checkIn}→${after.checkOut} (${after.roomTypeName})`, callId: call._id, isDemo: call.isDemo });
      return {
        done: true,
        verified: true,
        ...view(after),
        previousTotal: before.totalAmount,
        priceDifference: delta,
        paymentNote: delta === 0 ? undefined : "The price changed. Any extra charge or refund requires staff approval (request_payment_approval). Do not promise a refund or charge anything.",
      };
    } catch (e) {
      if (e instanceof BookingError && e.code === "unavailable") return { done: false, reason: "unavailable", message: e.message };
      if (e instanceof BookingError && e.code === "invalid") return fail("invalid", e.message);
      return fail("integration_unavailable", "The booking system did not respond. The reservation was NOT changed; offer a callback.");
    }
  },
});

export const cancelReservation = defineTool({
  name: "cancel_reservation",
  description:
    "Cancel an existing reservation after the caller has clearly confirmed they want to cancel. Needs the confirmation code and last name (or a matching phone). Only say it is cancelled if done=true. Refunds are never promised: they need staff approval.",
  schema: cancelReservationInput,
  async handler({ businessId, call }, input) {
    const provider = await getBookingProvider(businessId);
    if (!provider) return fail("integration_unavailable", NO_SYSTEM);
    const found = await load(provider, businessId, input.confirmationCode, { phone: call.callerNumber, lastName: input.guestLastName });
    if (!found.rec) return NOT_FOUND;
    if (!found.verified) return NOT_VERIFIED;
    try {
      await provider.cancelReservation(businessId, found.rec.confirmationCode);
      const check = await provider.findReservation(businessId, found.rec.confirmationCode).catch(() => null);
      if (check?.status !== "cancelled") return fail("verification_failed", "The cancellation could not be verified. Do not tell the caller it was cancelled; offer a callback.");
      await notify({ businessId, type: "info", title: `Reservation cancelled: ${found.rec.confirmationCode}`, body: `${found.rec.guestName}, ${found.rec.checkIn} to ${found.rec.checkOut}`, callId: call._id, isDemo: call.isDemo });
      return { done: true, verified: true, ...view(check), refundNote: "Any refund must be approved by staff. Do not promise one." };
    } catch {
      return fail("integration_unavailable", "The booking system did not respond. The reservation was NOT cancelled; offer a callback.");
    }
  },
});

export const lookupReservation = defineTool({
  name: "lookup_reservation",
  description:
    "Look up a reservation by confirmation code. Details are only returned after the caller is verified by last name (or a matching caller phone). Includes the status of any payment requests; never say a payment succeeded unless its status is 'paid'.",
  schema: lookupReservationInput,
  async handler({ businessId, call }, input) {
    const provider = await getBookingProvider(businessId);
    if (!provider) return fail("integration_unavailable", NO_SYSTEM);
    const found = await load(provider, businessId, input.confirmationCode, { phone: call.callerNumber, lastName: input.guestLastName });
    if (!found.rec) return NOT_FOUND;
    if (!found.verified) return NOT_VERIFIED;
    const payments = await PaymentApproval.find({ businessId, reservationId: { $exists: true } })
      .where("customerPhone")
      .in([found.rec.guestPhone, call.callerNumber].filter(Boolean))
      .select("kind amount status")
      .limit(5);
    return { done: true, verified: true, ...view(found.rec), payments: payments.map((p) => ({ kind: p.kind, amount: p.amount, status: p.status })) };
  },
});
