import { getBusinessInfoInput } from "../validators/tools";
import { formatHours, isOpenAt } from "../services/calls/businessHours";
import { matchFaqs } from "../services/ai/knowledgeSearch";
import { defineTool } from "./types";

/** The AI may only answer from what this returns. */
export const getBusinessInfo = defineTool({
  name: "get_business_info",
  description:
    "Get verified business information (hours, location, services, pricing, policies, FAQs). Use it before answering any factual question. If the answer is not in the result, say you don't have that information.",
  schema: getBusinessInfoInput,
  async handler({ business, knowledge }, input) {
    const k = knowledge;
    const all = input.topic === "all";
    const open = k ? isOpenAt(k.hours as never, business.timezone) : null;
    return {
      businessName: business.name,
      businessType: business.type,
      ...(all || input.topic === "location" ? { address: business.address, phone: business.phone } : {}),
      description: all ? k?.description : undefined,
      ...(all || input.topic === "hours" ? { hours: k ? formatHours(k.hours as never) : "Not set", openNow: open, timezone: business.timezone } : {}),
      ...(all || input.topic === "services" ? { services: k?.services ?? [] } : {}),
      ...(all || input.topic === "pricing" ? { pricing: k?.pricingInfo ?? "", servicePrices: (k?.services ?? []).filter((s) => s.price).map((s) => ({ name: s.name, price: s.price })) } : {}),
      ...(all || input.topic === "policies" ? { policies: k?.policies ?? "" } : {}),
      ...(all || input.topic === "faqs"
        ? { faqs: input.query ? matchFaqs(k, input.query, 4) : (k?.faqs ?? []) }
        : {}),
      note: "Only state facts present in this data. Never invent prices, availability or policies.",
    };
  },
});
