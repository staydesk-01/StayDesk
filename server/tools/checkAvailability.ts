import { checkAvailabilityInput } from "../validators/tools";
import { DAY_KEYS, formatHours } from "../services/calls/businessHours";
import { defineTool } from "./types";

/**
 * MVP: there is no PMS / calendar integration yet, so availability can never be *verified*.
 * The tool says so explicitly, which keeps the AI from promising rooms or slots.
 */
export const checkAvailability = defineTool({
  name: "check_availability",
  description:
    "Check whether the business is open on a date and whether live availability is connected. Live availability is NOT connected in this version: capture the request as a booking/appointment inquiry for staff to confirm.",
  schema: checkAvailabilityInput,
  async handler({ knowledge }, input) {
    let openThatDay: boolean | null = null;
    if (input.date && knowledge) {
      const d = new Date(`${input.date}T12:00:00Z`);
      if (!Number.isNaN(d.getTime())) {
        const key = DAY_KEYS[(d.getUTCDay() + 6) % 7];
        openThatDay = !knowledge.hours?.[key]?.closed;
      }
    }
    return {
      verified: false,
      available: null,
      businessOpenThatDay: openThatDay,
      hours: knowledge ? formatHours(knowledge.hours as never) : undefined,
      message:
        "Live availability is not connected. Do not promise availability or pricing; offer to record the request so staff can confirm it.",
    };
  },
});
