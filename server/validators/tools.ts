import { z } from "zod";
import { INTENTS, OUTCOMES, PRIORITIES } from "../models/enums";

const phone = z.string().trim().max(32).optional();
const text = (max: number) => z.string().trim().min(1).max(max);

export const getBusinessInfoInput = z.object({
  topic: z.enum(["all", "hours", "services", "pricing", "policies", "faqs", "location"]).default("all"),
  query: z.string().trim().max(300).optional().describe("The caller's question, used to pick the most relevant FAQs"),
});

export const checkAvailabilityInput = z.object({
  date: z.string().trim().max(40).optional().describe("Requested date, ideally YYYY-MM-DD"),
  partySize: z.coerce.number().int().min(1).max(500).optional(),
  service: z.string().trim().max(120).optional().describe("Room type, service or appointment type"),
});

export const createBookingOrLeadInput = z.object({
  type: z.enum(["booking", "appointment", "sales_lead"]),
  customerName: text(120),
  customerPhone: phone,
  customerEmail: z.string().trim().email().max(200).optional(),
  details: text(1000).describe("What the caller wants: dates, party size, service, budget, etc."),
  estimatedValue: z.coerce.number().min(0).max(1_000_000).optional().describe("Estimated value in dollars if it can be derived from verified pricing; otherwise omit"),
});

export const createServiceRequestInput = z.object({
  category: z.string().trim().min(1).max(60).default("general").describe("e.g. housekeeping, maintenance, front_desk, other"),
  description: text(1000),
  location: z.string().trim().max(120).optional().describe("Room number or address"),
  urgency: z.enum(PRIORITIES).default("normal"),
  customerName: z.string().trim().max(120).optional(),
  customerPhone: phone,
});

export const lookupExistingCustomerInput = z.object({
  phone: phone.describe("Defaults to the caller's number"),
  name: z.string().trim().max(120).optional(),
});

export const requestHumanTransferInput = z.object({
  reason: z.string().trim().max(300).default("Caller asked to speak with a person"),
});

export const createFollowUpInput = z.object({
  customerName: z.string().trim().max(120).optional(),
  phone: phone,
  reason: text(600),
  priority: z.enum(PRIORITIES).default("normal"),
  type: z.enum(["callback", "other"]).default("other").describe("Use 'callback' when the caller asked to be called back"),
  dueInHours: z.coerce.number().min(0.25).max(24 * 14).optional(),
});

export const sendConfirmationInput = z
  .object({
    channel: z.enum(["email", "sms"]),
    to: text(200),
    message: text(500),
  })
  .superRefine((v, ctx) => {
    if (v.channel === "email" && !z.string().email().safeParse(v.to).success)
      ctx.addIssue({ code: "custom", path: ["to"], message: "Invalid email address" });
    if (v.channel === "sms" && !/^\+?[\d\s().-]{7,20}$/.test(v.to))
      ctx.addIssue({ code: "custom", path: ["to"], message: "Invalid phone number" });
  });

export const saveCallSummaryInput = z.object({
  summary: text(1200),
  intent: z.enum(INTENTS).default("unknown"),
  outcome: z.enum(OUTCOMES).optional(),
  nextAction: z.string().trim().max(400).optional(),
  keyDetails: z.array(z.object({ label: text(60), value: text(300) })).max(12).optional(),
});

export const sendOwnerAlertInput = z.object({
  type: z.enum(["urgent_request", "unresolved_request", "callback_requested", "high_value_lead", "booking_inquiry", "info"]),
  title: text(140),
  message: text(600),
});
