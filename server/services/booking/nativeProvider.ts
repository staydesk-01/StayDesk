import { randomInt } from "node:crypto";
import type { Types } from "mongoose";
import { Reservation, RoomNight, RoomType } from "../../models";
import type { ReservationDoc, RoomTypeDoc } from "../../models";
import { diffDays, nightsBetween } from "../ai/dates";
import { BookingError, type BookingProvider, type CreateInput, type ModifyInput, type ReservationRecord, type RoomOption, type StayQuery } from "./provider";

// No 0/O/1/I/L: confirmation codes get read aloud over the phone.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const newConfirmationCode = () => `SD-${Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("")}`;

const toRecord = (r: ReservationDoc): ReservationRecord => ({
  confirmationCode: r.confirmationCode,
  guestName: r.guestName,
  guestPhone: r.guestPhone,
  roomTypeId: String(r.roomTypeId),
  roomTypeName: r.roomTypeName,
  checkIn: r.checkIn,
  checkOut: r.checkOut,
  nights: r.nights,
  guests: r.guests,
  nightlyRate: r.nightlyRate,
  totalAmount: r.totalAmount,
  status: r.status as ReservationRecord["status"],
});

/** Rooms of a type used on the busiest night of the stay, ignoring `excludeCode` (used when modifying). */
async function peakUsage(businessId: Types.ObjectId, roomTypeId: Types.ObjectId, q: StayQuery, excludeCode?: string) {
  const overlapping = await Reservation.find({
    businessId,
    roomTypeId,
    status: { $in: ["confirmed", "modified"] },
    checkIn: { $lt: q.checkOut },
    checkOut: { $gt: q.checkIn },
    ...(excludeCode ? { confirmationCode: { $ne: excludeCode } } : {}),
  }).select("checkIn checkOut");
  let peak = 0;
  for (const night of nightsBetween(q.checkIn, q.checkOut)) {
    const used = overlapping.filter((r) => r.checkIn <= night && night < r.checkOut).length;
    peak = Math.max(peak, used);
  }
  return peak;
}

/**
 * Atomically claims one unit for each night, or none at all. A conditional upsert (`used < capacity`) is applied
 * atomically by MongoDB; if the counter doc doesn't exist yet two callers may race to create it, so a duplicate-key
 * error is retried once before being treated as "full".
 */
async function claimNights(businessId: Types.ObjectId, roomTypeId: Types.ObjectId, nights: string[], capacity: number): Promise<boolean> {
  const claimed: string[] = [];
  for (const night of nights) {
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const r = await RoomNight.updateOne({ businessId, roomTypeId, night, used: { $lt: capacity } }, { $inc: { used: 1 } }, { upsert: true });
        ok = r.modifiedCount === 1 || r.upsertedCount === 1;
        break;
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e; // 11000: counter exists (and is full) or was just created by a rival: retry
      }
    }
    if (!ok) {
      await releaseNights(businessId, roomTypeId, claimed);
      return false;
    }
    claimed.push(night);
  }
  return true;
}

async function releaseNights(businessId: Types.ObjectId, roomTypeId: Types.ObjectId, nights: string[]) {
  if (nights.length) await RoomNight.updateMany({ businessId, roomTypeId, night: { $in: nights }, used: { $gt: 0 } }, { $inc: { used: -1 } });
}

const option = (rt: RoomTypeDoc, used: number): RoomOption => ({
  roomTypeId: String(rt._id),
  name: rt.name,
  nightlyRate: rt.nightlyRate,
  capacity: rt.capacity,
  total: rt.totalUnits,
  available: Math.max(0, rt.totalUnits - used),
});

/** StayDesk's built-in booking system, backed by MongoDB (RoomType + Reservation), scoped per business. */
export const nativeBookingProvider: BookingProvider = {
  id: "native",

  async isConfigured(businessId) {
    return !!(await RoomType.exists({ businessId, active: true }));
  },

  async listRoomTypes(businessId) {
    const types = await RoomType.find({ businessId, active: true }).sort({ nightlyRate: 1 });
    return types.map((t) => option(t, 0));
  },

  async checkAvailability(businessId, q) {
    const types = await RoomType.find({ businessId, active: true }).sort({ nightlyRate: 1 });
    const out: RoomOption[] = [];
    for (const t of types) out.push(option(t, await peakUsage(businessId, t._id, q)));
    return q.guests ? out.filter((o) => o.capacity >= q.guests!) : out;
  },

  async createReservation(businessId, input: CreateInput) {
    const rt = await RoomType.findOne({ _id: input.roomTypeId, businessId, active: true });
    if (!rt) throw new BookingError("not_found", "That room type does not exist.");
    if (input.guests > rt.capacity) throw new BookingError("invalid", `${rt.name} sleeps at most ${rt.capacity}.`);
    const nights = diffDays(input.checkIn, input.checkOut);
    if (nights < 1) throw new BookingError("invalid", "Check-out must be after check-in.");
    // Idempotency: a retried request for the same call, guest, room and dates returns the reservation already made, never a second one.
    if (input.callId) {
      const dup = await Reservation.findOne({ businessId, callId: input.callId, roomTypeId: rt._id, checkIn: input.checkIn, checkOut: input.checkOut, guestName: input.guestName, status: { $in: ["confirmed", "modified"] } });
      if (dup) return toRecord(dup);
    }
    if (rt.totalUnits - (await peakUsage(businessId, rt._id, input)) < 1) throw new BookingError("unavailable", `${rt.name} is not available for those dates.`);

    const stayNights = nightsBetween(input.checkIn, input.checkOut);
    if (!(await claimNights(businessId, rt._id, stayNights, rt.totalUnits))) throw new BookingError("unavailable", `${rt.name} was just booked by someone else.`);

    let doc: ReservationDoc | null = null;
    for (let attempt = 0; attempt < 5 && !doc; attempt++) {
      try {
        doc = await Reservation.create({
          businessId,
          callId: input.callId,
          confirmationCode: newConfirmationCode(),
          guestName: input.guestName,
          guestPhone: input.guestPhone,
          guestEmail: input.guestEmail ?? "",
          roomTypeId: rt._id,
          roomTypeName: rt.name,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          nights,
          guests: input.guests,
          nightlyRate: rt.nightlyRate,
          totalAmount: Math.round(rt.nightlyRate * nights * 100) / 100,
          source: input.source ?? "ai_call",
          history: [{ at: new Date(), action: "created", detail: "Reservation created" }],
          isDemo: input.isDemo ?? false,
        });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e; // duplicate code: retry with a new one
      }
    }
    if (!doc) {
      await releaseNights(businessId, rt._id, stayNights);
      throw new BookingError("integration_unavailable", "Could not allocate a confirmation code.");
    }
    return toRecord(doc);
  },

  async findReservation(businessId, code) {
    const r = await Reservation.findOne({ businessId, confirmationCode: code.trim().toUpperCase() });
    return r ? toRecord(r) : null;
  },

  async modifyReservation(businessId, code, changes: ModifyInput) {
    const r = await Reservation.findOne({ businessId, confirmationCode: code.trim().toUpperCase() });
    if (!r) throw new BookingError("not_found", "Reservation not found.");
    if (r.status === "cancelled") throw new BookingError("invalid", "That reservation was cancelled.");
    const before = { checkIn: r.checkIn, checkOut: r.checkOut, roomTypeId: r.roomTypeId, roomTypeName: r.roomTypeName, nightlyRate: r.nightlyRate, nights: r.nights, guests: r.guests, totalAmount: r.totalAmount, status: r.status };

    const rt = await RoomType.findOne({ _id: changes.roomTypeId ?? r.roomTypeId, businessId, active: true });
    if (!rt) throw new BookingError("not_found", "That room type does not exist.");
    const checkIn = changes.checkIn ?? r.checkIn;
    const checkOut = changes.checkOut ?? r.checkOut;
    const guests = changes.guests ?? r.guests;
    const nights = diffDays(checkIn, checkOut);
    if (nights < 1) throw new BookingError("invalid", "Check-out must be after check-in.");
    if (guests > rt.capacity) throw new BookingError("invalid", `${rt.name} sleeps at most ${rt.capacity}.`);
    if (rt.totalUnits - (await peakUsage(businessId, rt._id, { checkIn, checkOut }, r.confirmationCode)) < 1) throw new BookingError("unavailable", `${rt.name} is not available for those dates.`);

    // Move the claim atomically: take the new nights first, then give back the old ones.
    const oldNights = nightsBetween(before.checkIn, before.checkOut);
    const newNights = nightsBetween(checkIn, checkOut);
    const sameRoom = String(before.roomTypeId) === String(rt._id);
    const stay = (n: string[]) => (sameRoom ? n.filter((x) => !oldNights.includes(x)) : n); // nights we already hold stay claimed
    const toClaim = stay(newNights);
    if (!(await claimNights(businessId, rt._id, toClaim, rt.totalUnits))) throw new BookingError("unavailable", `${rt.name} was just booked by someone else.`);
    const toRelease = sameRoom ? oldNights.filter((x) => !newNights.includes(x)) : oldNights;
    await releaseNights(businessId, before.roomTypeId, toRelease);

    r.set({ checkIn, checkOut, nights, guests, roomTypeId: rt._id, roomTypeName: rt.name, nightlyRate: rt.nightlyRate, totalAmount: Math.round(rt.nightlyRate * nights * 100) / 100, status: "modified" });
    r.history.push({ at: new Date(), action: "modified", detail: `${before.checkIn}→${before.checkOut} (${before.roomTypeName}) changed to ${checkIn}→${checkOut} (${rt.name})` });
    await r.save();
    return toRecord(r);
  },

  async cancelReservation(businessId, code) {
    const r = await Reservation.findOne({ businessId, confirmationCode: code.trim().toUpperCase() });
    if (!r) throw new BookingError("not_found", "Reservation not found.");
    if (r.status === "cancelled") return toRecord(r);
    r.status = "cancelled";
    r.history.push({ at: new Date(), action: "cancelled", detail: "Cancelled by guest" });
    await r.save();
    await releaseNights(businessId, r.roomTypeId, nightsBetween(r.checkIn, r.checkOut));
    return toRecord(r);
  },
};
