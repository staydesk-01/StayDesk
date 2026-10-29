import { Call, Opportunity, ServiceRequest } from "../models";
import { lookupExistingCustomerInput } from "../validators/tools";
import { normalizePhone } from "../utils/phone";
import { defineTool } from "./types";

/**
 * Looks only at this business's own StayDesk history. It deliberately returns minimal data
 * (first name, counts, request statuses) – no reservation, payment or other personal details.
 */
export const lookupExistingCustomer = defineTool({
  name: "lookup_existing_customer",
  description:
    "Check whether this caller (by phone) has contacted the business before and whether they have open requests. Returns limited info only; no reservation or payment details are available by phone.",
  schema: lookupExistingCustomerInput,
  async handler({ businessId, call, business }, input) {
    // Healthcare: patient information is never disclosed by phone through the AI (identity can't be verified here).
    if (business.type === "medical") {
      return { found: false, privacy: true, message: "For patient privacy, no information about existing patients is shared on this call. Offer to have a staff member call them back." };
    }
    const phone = normalizePhone(input.phone) || call.callerNumber;
    if (!phone) return { found: false, message: "No phone number to look up." };
    const [calls, opportunities, requests] = await Promise.all([
      Call.find({ businessId, callerNumber: phone, _id: { $ne: call._id } }).sort({ startedAt: -1 }).limit(5).select("callerName startedAt intent"),
      Opportunity.find({ businessId, customerPhone: phone }).sort({ createdAt: -1 }).limit(3).select("type status createdAt"),
      ServiceRequest.find({ businessId, customerPhone: phone, status: { $in: ["open", "in_progress"] } }).select("category status description"),
    ]);
    if (!calls.length && !opportunities.length && !requests.length) return { found: false, message: "No previous contact found for this number." };
    const name = calls.find((c) => c.callerName)?.callerName?.split(" ")[0];
    return {
      found: true,
      firstName: name,
      previousCalls: calls.length,
      lastCallAt: calls[0]?.startedAt,
      recentOpportunities: opportunities.map((o) => ({ type: o.type, status: o.status })),
      openServiceRequests: requests.map((r) => ({ category: r.category, status: r.status, description: r.description })),
      note: "Do not share more than this. For reservation or account details, offer a staff callback.",
    };
  },
});
