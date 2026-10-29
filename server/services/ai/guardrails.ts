import type { BusinessDoc, CallDoc } from "../../models";
import { Call } from "../../models";
import { runTool } from "../../tools/registry";
import { containsCardData, containsSensitiveId } from "../safety/sensitive";

/**
 * Rules that apply to EVERY reply regardless of which brain (rules or LLM) is active. They run before the brain, so
 * they cannot be talked around by the caller or skipped by a model.
 */
export interface GuardResult {
  kind: "card_data" | "ai_identity" | "medical_emergency" | "clinical_advice";
  reply: string;
}

const AI_IDENTITY = [
  /\b(are|r)\s+(you|u)\s+(a\s+|an\s+)?(real\s+|live\s+)?(human|person|robot|bot|ai|machine|computer|recording|automated)\b/i,
  /\b(am i|i am)\s+(talking|speaking)\s+(to|with)\s+(a\s+|an\s+)?(real\s+|live\s+)?(human|person|robot|bot|machine|computer|ai|recording)\b/i,
  /\bis\s+(this|that)\s+(a\s+|an\s+)?(real\s+person|real\s+human|human|robot|bot|recording|ai|automated)\b/i,
  /\byou\s+(a\s+|an\s+)?(real\s+)?(robot|bot|ai)\b\?/i,
  /\byou('re| are)\s+(a\s+|an\s+)?(real\s+)?(robot|bot|ai|machine|computer|recording)\b/i,
  /\bis\s+(this|that)\s+(a\s+|an\s+)?(recorded|automated|pre-?recorded)\b/i,
];

const MEDICAL_EMERGENCY =
  /\b(chest pain|can'?t breathe|cannot breathe|trouble breathing|difficulty breathing|overdos(e|ed|ing)|suicid(e|al)|kill myself|bleeding (heavily|a lot|badly)|heart attack|stroke|unconscious|not breathing|seizure|severe allergic|anaphyla)/i;

const CLINICAL =
  /\b(symptom|symptoms|medication|medications|medicine|dosage|dose|prescri(be|ption)|diagnos(is|ed|e)|side effects?|test results?|lab results?|blood (work|test|pressure)|x-?ray|mri|should i take|is it normal|is it safe to|treatment|infection|rash|fever|pain|swelling|pregnan|refill|allerg(y|ies|ic))\b/i;

async function followUp(call: CallDoc, reason: string, priority: "high" | "urgent") {
  await runTool("create_follow_up", { businessId: call.businessId, callId: call._id }, { reason, priority, type: priority === "urgent" ? "other" : "callback" });
}

export async function applyGuardrails(call: CallDoc, business: BusinessDoc, text: string): Promise<GuardResult | null> {
  const state = (call.agentState ?? {}) as { cardWarned?: boolean };

  // 1. Payment card / ID numbers: never taken, never stored (the transcript layer also redacts them).
  if (containsCardData(text) || containsSensitiveId(text)) {
    if (!state.cardWarned) {
      await Call.updateOne({ _id: call._id }, { $set: { "agentState.cardWarned": true } });
      await followUp(call, "Caller began reading payment card or ID numbers. Nothing was recorded. Please call them back and offer a secure way to pay.", "high");
    }
    return {
      kind: "card_data",
      reply:
        "For your security, please don't share card or ID numbers on this call. I can't take payments over the phone. I can ask our team to follow up with a secure way to pay. Is there anything else I can help with?",
    };
  }

  // 2. Never pretend to be human.
  if (AI_IDENTITY.some((re) => re.test(text)) && !/\b(speak|talk|connect|transfer|put me)\b/i.test(text)) {
    return {
      kind: "ai_identity",
      reply: `I'm an AI assistant for ${business.name}, not a person. I can help with most questions, or connect you with a team member if you'd like.`,
    };
  }

  // 3. Healthcare offices: privacy, clinical-safety and emergency rules (administrative help only).
  if (business.type === "medical") {
    if (MEDICAL_EMERGENCY.test(text)) {
      await followUp(call, "URGENT: caller described a possible medical emergency and was told to call 911. Details were not recorded.", "urgent");
      await runTool("send_owner_alert", { businessId: call.businessId, callId: call._id }, { type: "urgent_request", title: "Possible medical emergency on a call", message: "A caller described a possible emergency and was told to call 911." });
      return { kind: "medical_emergency", reply: "If this is a medical emergency, please hang up and call 911 right now. I've alerted our team. Please call 911 first." };
    }
    if (CLINICAL.test(text)) {
      await followUp(call, "Caller asked a clinical or medical question. The AI does not give medical advice; a clinical team member should call them back. Details were not recorded.", "high");
      return {
        kind: "clinical_advice",
        reply:
          "I'm not able to give medical advice or discuss clinical details. I've asked a member of our team to call you back about that. I can also help you schedule an appointment or answer questions about our office hours. What would you like?",
      };
    }
  }
  return null;
}

/** Healthcare transcripts keep the fact a clinical question was asked, not the clinical details. */
export function transcriptSafeText(business: Pick<BusinessDoc, "type">, text: string, guard: GuardResult | null): string {
  if (guard?.kind === "clinical_advice" || guard?.kind === "medical_emergency") return "[health information withheld]";
  return text;
}
