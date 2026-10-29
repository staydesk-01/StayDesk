import { z } from "zod";
import { logger } from "../../config/logger";
import { env } from "../../config/env";
import { FollowUp, Opportunity, PaymentApproval, Reservation, ServiceRequest } from "../../models";
import type { CallDoc, Intent, TranscriptDoc } from "../../models";
import { INTENTS } from "../../models";
import { INTENT_LABELS } from "../ai/intent";
import { getOpenAI } from "../ai/openaiClient";

export interface SummaryDraft {
  summary: string;
  intent?: Intent;
  nextAction: string;
  keyDetails: { label: string; value: string }[];
  generatedBy: "ai" | "template";
}

const REASON_TEXT: Record<string, string> = {
  direct_ai: "AI-first routing",
  busy: "the staff line was busy",
  no_answer: "nobody answered in time",
  overflow: "all staff were already on calls",
  after_hours: "the call came in after hours",
};

const OPP_LABEL: Record<string, string> = {
  booking: "booking inquiry",
  appointment: "appointment request",
  sales_lead: "sales lead",
  service_inquiry: "service inquiry",
};

const aiSchema = z.object({
  summary: z.string().min(1).max(900),
  intent: z.enum(INTENTS).optional(),
  nextAction: z.string().max(300).default(""),
});

async function collectFacts(call: CallDoc) {
  const [opps, reqs, followUps, reservations, payments] = await Promise.all([
    Opportunity.find({ callId: call._id }),
    ServiceRequest.find({ callId: call._id }),
    FollowUp.find({ callId: call._id }),
    Reservation.find({ callId: call._id }),
    PaymentApproval.find({ callId: call._id }),
  ]);
  return { opps, reqs, followUps, reservations, payments };
}

export async function generateSummary(call: CallDoc, transcript: TranscriptDoc | null, businessName: string): Promise<SummaryDraft> {
  const { opps, reqs, followUps, reservations, payments } = await collectFacts(call);
  const who = call.callerName || call.callerNumber || "An unknown caller";

  const keyDetails: SummaryDraft["keyDetails"] = [];
  if (call.callerName) keyDetails.push({ label: "Caller", value: call.callerName });
  if (call.callerNumber) keyDetails.push({ label: "Phone", value: call.callerNumber });
  for (const o of opps) keyDetails.push({ label: `Opportunity (${o.type.replace("_", " ")})`, value: o.details || "—" });
  for (const r of reqs) keyDetails.push({ label: `Service request (${r.category})`, value: r.description });

  const nextAction = followUps.find((f) => f.status !== "completed")?.reason ?? "";

  const facts: string[] = [];
  for (const r of reservations) facts.push(`Reservation ${r.confirmationCode} ${r.status}: ${r.roomTypeName}, ${r.checkIn} to ${r.checkOut}, ${r.guests} guest(s).`);
  for (const p of payments) facts.push(`A ${p.kind} approval request${p.amount != null ? ` ($${p.amount})` : ""} is ${p.status}; no money moved until a human approves and the payment system confirms.`);
  if (opps.length) facts.push(`Captured ${opps.map((o) => `a ${OPP_LABEL[o.type] ?? o.type}`).join(", ")}.`);
  if (reqs.length) facts.push(`Created ${reqs.length === 1 ? "a service request" : `${reqs.length} service requests`}: ${reqs.map((r) => r.description).join("; ")}.`);
  if (call.transferAttempted) {
    facts.push(
      call.transferStatus === "answered"
        ? "The caller was transferred to a staff member."
        : "The caller asked for a person but the transfer was not answered.",
    );
  }
  if (followUps.length) facts.push(`A follow-up was created: ${followUps[0].reason}`);

  const template: SummaryDraft = {
    summary: `${who} called ${businessName}; the call reached StayDesk AI because ${REASON_TEXT[call.routingReason] ?? "of routing rules"}. Topic: ${INTENT_LABELS[call.intent as Intent].toLowerCase()}. ${facts.join(" ") || "The AI answered the caller's questions; no follow-up action was needed."}`,
    intent: call.intent as Intent,
    nextAction: nextAction || "No action needed.",
    keyDetails,
    generatedBy: "template",
  };

  if (call.handledBy === "human") {
    return {
      ...template,
      summary: `${who} called ${businessName} and was answered by staff. StayDesk AI was not needed.`,
      nextAction: "No action needed.",
    };
  }

  const openai = getOpenAI();
  const segments = transcript?.segments.filter((s) => s.role === "caller" || s.role === "agent") ?? [];
  if (!openai || segments.length < 2) return template;

  try {
    const convo = segments.map((s) => `${s.role === "caller" ? "Caller" : "Agent"}: ${s.text}`).join("\n").slice(0, 8000);
    const res = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `You summarise phone calls for ${businessName}'s staff. Reply with JSON {"summary": string (2-3 sentences, factual, no invented details), "intent": one of ${INTENTS.join("|")}, "nextAction": string}. ` +
            `Backend facts (authoritative): ${JSON.stringify({ opportunities: opps.length, serviceRequests: reqs.length, followUps: followUps.map((f) => f.reason), transfer: call.transferStatus })}.`,
        },
        { role: "user", content: convo },
      ],
    });
    const parsed = aiSchema.parse(JSON.parse(res.choices[0]?.message?.content ?? "{}"));
    return { ...template, summary: parsed.summary, intent: parsed.intent ?? template.intent, nextAction: parsed.nextAction || template.nextAction, generatedBy: "ai" };
  } catch (e) {
    logger.warn("AI summary failed, using template", { message: (e as Error).message });
    return template;
  }
}
