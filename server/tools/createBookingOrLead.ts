import { Call, Opportunity } from "../models";
import { createBookingOrLeadInput } from "../validators/tools";
import { notify } from "../services/notifications/notificationService";
import { publish } from "../services/realtime";
import { normalizePhone } from "../utils/phone";
import { defineTool } from "./types";

const TYPE_MAP = { booking: "booking", appointment: "appointment", sales_lead: "sales_lead" } as const;

export const createBookingOrLead = defineTool({
  name: "create_booking_or_lead",
  description:
    "Record a booking inquiry, appointment request or sales lead after you have the caller's name and what they want. This does NOT confirm anything; staff confirm later.",
  schema: createBookingOrLeadInput,
  async handler({ businessId, call, business }, input) {
    const phone = normalizePhone(input.customerPhone) || call.callerNumber;
    // Idempotency: the same inquiry from the same call is recorded once, however many times the request is retried.
    const dup = await Opportunity.findOne({ businessId, callId: call._id, type: TYPE_MAP[input.type], customerName: input.customerName, details: input.details });
    if (dup) return { opportunityId: String(dup._id), status: dup.status, duplicate: true, note: "Already recorded for staff to confirm. Tell the caller the team will follow up; do not promise availability or a price." };
    const opportunity = await Opportunity.create({
      businessId,
      callId: call._id,
      type: TYPE_MAP[input.type],
      customerName: input.customerName,
      customerPhone: phone,
      customerEmail: input.customerEmail ?? "",
      details: input.details,
      estimatedValue: input.estimatedValue ?? 0,
      isDemo: call.isDemo,
    });
    await Call.updateOne(
      { _id: call._id },
      { $set: { callerName: call.callerName || input.customerName } },
    );

    const link = `/calls/${call._id}`;
    const label = input.type === "sales_lead" ? "sales lead" : `${input.type} inquiry`;
    if (input.type !== "sales_lead") {
      await notify({
        businessId,
        type: "booking_inquiry",
        title: `New ${label} from ${input.customerName}`,
        body: input.details,
        link,
        callId: call._id,
        isDemo: call.isDemo,
      });
    }
    const threshold = business.notificationPrefs?.highValueThreshold ?? 500;
    if ((input.estimatedValue ?? 0) >= threshold) {
      await notify({
        businessId,
        type: "high_value_lead",
        title: `High-value ${label}: ~$${input.estimatedValue}`,
        body: `${input.customerName}: ${input.details}`,
        link,
        callId: call._id,
        isDemo: call.isDemo,
      });
    }
    publish(businessId, "opportunity.updated", { id: String(opportunity._id) });
    return {
      opportunityId: String(opportunity._id),
      status: "new",
      note: "Recorded for staff to confirm. Tell the caller the team will follow up; do not promise availability or a price.",
    };
  },
});
