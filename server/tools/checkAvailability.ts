import { checkAvailabilityInput } from "../validators/tools";
import { DAY_KEYS, localDateKey, formatHours } from "../services/calls/businessHours";
import { diffDays } from "../services/ai/dates";
import { getBookingProvider } from "../services/booking";
import { defineTool } from "./types";

/**
 * With a connected booking system and dates, this returns LIVE availability read from it.
 * Without one, it says plainly that nothing can be verified, so the agent never promises a room or slot.
 */
export const checkAvailability = defineTool({
  name: "check_availability",
  description:
    "Check live room availability and prices for a stay (checkIn + checkOut as YYYY-MM-DD). If no booking system is connected the result says availability is NOT verified: then capture the request as an inquiry for staff to confirm. Never state availability or prices that this tool did not return.",
  schema: checkAvailabilityInput,
  async handler({ businessId, business, knowledge }, input) {
    const provider = await getBookingProvider(businessId);

    if (provider && input.checkIn && input.checkOut) {
      const today = localDateKey(new Date(), business.timezone);
      const nights = diffDays(input.checkIn, input.checkOut);
      if (nights < 1) return { verified: false, message: "Check-out must be after check-in. Ask the caller to confirm their dates." };
      if (input.checkIn < today) return { verified: false, message: "Those dates are in the past. Ask the caller for upcoming dates." };
      if (nights > 30) return { verified: false, message: "Stays longer than 30 nights need a staff member. Offer a callback." };
      const options = await provider.checkAvailability(businessId, { checkIn: input.checkIn, checkOut: input.checkOut, guests: input.guests });
      return {
        verified: true,
        source: provider.id,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights,
        rooms: options.map((o) => ({ roomType: o.name, roomsAvailable: o.available, nightlyRate: o.nightlyRate, totalForStay: Math.round(o.nightlyRate * nights * 100) / 100, sleeps: o.capacity })),
        anyAvailable: options.some((o) => o.available > 0),
      };
    }
    if (provider) {
      return { verified: false, available: null, message: "A booking system is connected. Ask for check-in and check-out dates (and number of guests), then call this tool again with checkIn and checkOut." };
    }

    let openThatDay: boolean | null = null;
    if (input.date && knowledge) {
      const d = new Date(`${input.date}T12:00:00Z`);
      if (!Number.isNaN(d.getTime())) openThatDay = !knowledge.hours?.[DAY_KEYS[(d.getUTCDay() + 6) % 7]]?.closed;
    }
    return {
      verified: false,
      available: null,
      businessOpenThatDay: openThatDay,
      hours: knowledge ? formatHours(knowledge.hours as never) : undefined,
      message: "Live availability is not connected. Do not promise availability or pricing; offer to record the request so staff can confirm it.",
    };
  },
});
