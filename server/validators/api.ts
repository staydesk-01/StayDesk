import { z } from "zod";
import {
  BUSINESS_TYPES,
  FOLLOW_UP_STATUSES,
  NOTIFICATION_TYPES,
  OPPORTUNITY_STATUSES,
  PRIORITIES,
  ROLES,
  SERVICE_REQUEST_STATUSES,
} from "../models/enums";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use HH:mm");
const str = (max = 200) => z.string().trim().max(max);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const tz = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "Unknown timezone");

export const signupBody = z.object({
  name: str(120).min(1),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, "At least 8 characters").max(128),
  businessName: str(160).min(1),
  businessType: z.enum(BUSINESS_TYPES).optional(),
});

export const loginBody = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

export const teamCreateBody = z.object({
  name: str(120).min(1),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(128),
  role: z.enum(ROLES),
});
export const teamUpdateBody = z.object({ role: z.enum(ROLES).optional(), active: z.boolean().optional() });

export const businessPatch = z
  .object({
    name: str(160).min(1),
    type: z.enum(BUSINESS_TYPES),
    phone: str(32),
    address: str(300),
    timezone: tz,
    escalationPhone: str(32),
    ownerEmail: z.union([z.string().trim().toLowerCase().email().max(200), z.literal("")]),
    agentName: str(60).min(1),
    onboardingComplete: z.boolean(),
    notificationPrefs: z
      .object({
        inApp: z.boolean(),
        email: z.boolean(),
        sms: z.boolean(),
        events: z.array(z.enum(NOTIFICATION_TYPES)).max(20),
        highValueThreshold: z.coerce.number().min(0).max(1_000_000),
      })
      .partial(),
    privacy: z
      .object({
        recordingEnabled: z.boolean(),
        recordingConsentMessage: str(400).min(1),
        transcriptRetentionDays: z.coerce.number().int().min(1).max(3650),
      })
      .partial(),
  })
  .partial();

const dayHours = z.object({ closed: z.boolean().default(false), open: hhmm.default("09:00"), close: hhmm.default("17:00") });
export const knowledgePatch = z
  .object({
    description: str(3000),
    hours: z.object({ mon: dayHours, tue: dayHours, wed: dayHours, thu: dayHours, fri: dayHours, sat: dayHours, sun: dayHours }).partial(),
    services: z.array(z.object({ name: str(120).min(1), description: str(600).default(""), price: str(80).default("") })).max(100),
    faqs: z.array(z.object({ question: str(300).min(1), answer: str(1500).min(1) })).max(200),
    pricingInfo: str(3000),
    policies: str(5000),
    escalationContacts: z.array(z.object({ name: str(120).min(1), phone: str(32).min(3), role: str(80).default("") })).max(20),
  })
  .partial();

export const routingPatch = z
  .object({
    mode: z.enum(["new_twilio", "existing_number"]),
    twilioNumber: str(32),
    existingNumber: str(32),
    voiceProvider: z.enum(["twilio_gather", "retell", "vapi"]),
    humanFirst: z.boolean(),
    ringSeconds: z.coerce.number().int().min(5).max(60),
    noAnswerToAi: z.boolean(),
    busyToAi: z.boolean(),
    afterHoursToAi: z.boolean(),
    overflowToAi: z.boolean(),
    maxConcurrentHumanCalls: z.coerce.number().int().min(1).max(50),
    aiOnly: z.boolean(),
    humanNumber: str(32),
    forwardingConfigured: z.boolean(),
    agentActive: z.boolean(),
  })
  .partial();

export const callsQuery = z.object({
  range: z.enum(["today", "7d", "30d", "all"]).default("30d"),
  filter: z.enum(["all", "ai", "transferred", "follow_up", "completed", "failed"]).default("all"),
  q: str(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const followUpsQuery = z.object({
  status: z.enum([...FOLLOW_UP_STATUSES, "active", "all"]).default("active"),
  priority: z.enum(PRIORITIES).optional(),
  mine: z.enum(["true", "false"]).optional(),
  callId: objectId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const followUpCreate = z.object({
  callId: objectId.optional(),
  customerName: str(120).default(""),
  phone: str(32).default(""),
  reason: str(600).min(1),
  priority: z.enum(PRIORITIES).default("normal"),
  assignedTo: objectId.optional(),
  dueAt: z.coerce.date().optional(),
});

export const followUpPatch = z.object({
  status: z.enum(FOLLOW_UP_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignedTo: objectId.nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  note: str(1000).min(1).optional(),
});

export const opportunitiesQuery = z.object({
  status: z.enum([...OPPORTUNITY_STATUSES, "all"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const opportunityPatch = z.object({
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
  estimatedValue: z.coerce.number().min(0).max(1_000_000).optional(),
  /** Confirmed transaction amount. Only accepted together with / for a "converted" opportunity. */
  verifiedValue: z.coerce.number().min(0).max(1_000_000).nullable().optional(),
});

export const serviceRequestPatch = z.object({ status: z.enum(SERVICE_REQUEST_STATUSES) });

export const dashboardQuery = z.object({ range: z.enum(["today", "7d", "30d"]).default("7d") });

export const testSessionBody = z.object({
  simulateTransferAnswers: z.boolean().default(false),
  callerNumber: str(32).default("+15550100123"),
  routingReason: z.enum(["direct_ai", "busy", "no_answer", "overflow", "after_hours"]).default("no_answer"),
});
export const testMessageBody = z.object({ text: str(1000).min(1) });

export const agentChatBody = z.object({
  message: str(1000).min(1),
  /** Continue an existing test conversation; omit to start a new one. */
  sessionId: objectId.optional(),
});
