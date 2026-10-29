import { Call } from "../../models";
import type { CallDoc } from "../../models";
import { runTool } from "../../tools/registry";
import { FAREWELL } from "./prompt";
import { classifyIntent } from "./intent";
import { bestAnswer, matchServices, parsePrice, unknownTerms } from "./knowledgeSearch";
import { getBookingProvider } from "../booking";
import { extractName } from "./extract";
import { handleWorkflows } from "./workflows";
import { answerQuestions, looksLikeQuestion, splitQuestions } from "./questions";
import type { Wf } from "./workflows";
export { extractName };
import type { AgentBrain, AgentTurnResult, BrainInput } from "./types";

type Flow = "booking" | "appointment" | "lead" | "service" | "complaint" | "callback";
type Awaiting = "details" | "name" | "location" | "more" | "offer_callback";

export interface RuleState {
  flow?: Flow;
  awaiting?: Awaiting;
  slots: { name?: string; details?: string; location?: string; urgent?: boolean };
  nameRetries?: number;
  /** A question we could not verify has already been queued for staff on this call (never queue the same kind of follow-up repeatedly). */
  unverifiedNoted?: boolean;
  /** The caller said they do not want a callback: never offer or promise one again on this call. */
  callbackDeclined?: boolean;
  lastUnverified?: string;
  simulateTransferAnswers?: boolean;
  silentTurns?: number;
  /** Active multi-step workflow (reservation, payment …), see workflows.ts */
  wf?: Wf;
  voice?: { language?: string; hints?: string };
}

const YES = /\b(yes|yeah|yep|yup|sure|please|okay|ok|absolutely|definitely|that would be great|go ahead)\b/i;
const NO = /\b(no|nope|nah|not now|don'?t|no thanks?|no thank you)\b/i;
const BYE = /\b(bye|goodbye|good-bye|that'?s (all|it)|nothing( else)?|i'?m (good|done|all set)|all set|have a (good|great|nice))\b/i;

const hasDateHint = (t: string) =>
  /\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\btomorrow|tonight|today|next week|weekend|\d{1,2}(st|nd|rd|th)\b|\d+\s*nights?|\d{1,2}\/\d{1,2}/i.test(t);

const hasTimeHint = (t: string) => /\b\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|\b(morning|afternoon|evening|noon|midday|o'?clock)\b|\bat \d{1,2}\b/i.test(t);

const hasCountHint = (t: string) => /\b(\d+|one|two|three|four|five|six|couple|adults?|guests?|people|persons?|nights?|kids?|children|family)\b/i.test(t);

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, a: 1 };
/** "2 nights" / "two nights" -> 2 (defaults to 1). */
export function countNights(text: string): number {
  const m = text.match(/\b(\d+|one|two|three|four|five|six|seven)\s*nights?\b/i);
  if (!m) return 1;
  return Number(m[1]) || WORD_NUMBERS[m[1].toLowerCase()] || 1;
}

const extractLocation = (t: string) => t.match(/\b(room|suite|unit|apt|apartment)\s*#?\s*(\d+[a-z]?)/i)?.slice(1).join(" ");

function categoryFor(t: string): string {
  if (/\b(towel|pillow|blanket|clean|housekeeping|sheet|linen|toiletr)/i.test(t)) return "housekeeping";
  if (/\b(broken|leak|toilet|shower|air|heat|a\/c|light|tv|remote|wifi|clog|repair|fix|not working)/i.test(t)) return "maintenance";
  return "general";
}

/** Live room rates, or [] if the booking system is down: answering questions must never depend on it. */
async function safeRooms(businessId: CallDoc["businessId"]) {
  try {
    const prov = await getBookingProvider(businessId);
    return prov ? await prov.listRoomTypes(businessId) : [];
  } catch {
    return [];
  }
}

export class RuleBrain implements AgentBrain {
  async respond({ call, business, knowledge, userText }: BrainInput): Promise<AgentTurnResult> {
    const state: RuleState = { slots: {}, ...(call.agentState as Partial<RuleState>) };
    state.slots ??= {};
    const ctx = { businessId: call.businessId, callId: call._id };
    const t = userText.trim();
    const say = async (reply: string, patch: Partial<RuleState> = {}, extra: Partial<AgentTurnResult> = {}): Promise<AgentTurnResult> => {
      Object.assign(state, patch);
      await Call.updateOne({ _id: call._id }, { $set: { agentState: state } });
      return { reply, end: false, transfer: false, ...extra };
    };
    const more = (lead: string) => say(`${lead} Is there anything else I can help you with?`, { flow: undefined, awaiting: "more", slots: {} });
    const first = (n?: string) => (n ? n.split(" ")[0] : "");
    const info = async (topic: string, query?: string) => {
      const r = await runTool("get_business_info", ctx, { topic, query });
      return r.ok ? (r.data as Record<string, any>) : {};
    };

    const intent = classifyIntent(t);

    // ---- completion helpers -------------------------------------------------
    const completeLead = async (flow: "booking" | "appointment" | "lead") => {
      const { name, details } = state.slots;
      const service = matchServices(knowledge, details ?? "")[0];
      const unit = parsePrice(service?.price);
      const nights = countNights(details ?? "");
      const estimatedValue = unit ? unit * (flow === "booking" ? Math.max(1, nights) : 1) : undefined;
      const type = flow === "lead" ? "sales_lead" : flow;
      const r = await runTool("create_booking_or_lead", ctx, { type, customerName: name, details, estimatedValue });
      if (!r.ok) return more("I'm sorry, I had trouble saving that, so I've asked the team to call you back.");
      // The inquiry is already saved for staff. A callback is only promised if the caller wants one AND the task really exists.
      const fu = state.callbackDeclined
        ? null
        : await runTool("create_follow_up", ctx, {
            customerName: name,
            reason: `Confirm ${type.replace("_", " ")} inquiry for ${name}: ${details}`,
            priority: estimatedValue && estimatedValue >= (business.notificationPrefs?.highValueThreshold ?? 500) ? "high" : "normal",
            type: "other",
          });
      const what = flow === "booking" ? "booking request" : flow === "appointment" ? "appointment request" : "inquiry";
      const tail = flow === "booking" || flow === "appointment" ? " I can't confirm it myself, so it is not confirmed yet." : "";
      if (!fu) return more(`Thank you, ${first(name)}. I've recorded your ${what} for our team.${tail}`);
      return more(fu.ok ? `Thank you, ${first(name)}. I've passed your ${what} to our team and they'll call you back at this number to confirm.${tail}` : `Thank you, ${first(name)}. I've recorded your ${what} for our team, but I couldn't schedule the callback.${tail}`);
    };

    const completeService = async () => {
      const { details, location, name, urgent } = state.slots;
      const r = await runTool("create_service_request", ctx, {
        category: categoryFor(details ?? ""),
        description: details,
        location,
        urgency: urgent ? "urgent" : "normal",
        customerName: name,
      });
      if (!r.ok) return more("I'm sorry, I couldn't log that request, but I've asked the team to call you back.");
      if (urgent) {
        await runTool("create_follow_up", ctx, { reason: `URGENT: ${details}`, priority: "urgent", type: "other" });
        await runTool("send_owner_alert", ctx, { type: "urgent_request", title: "Urgent request from a caller", message: details ?? "" });
      }
      return more("I've sent that to our team right away.");
    };

    const completeCallback = async (priority: "normal" | "high" = "normal") => {
      const { name, details } = state.slots;
      await runTool("create_follow_up", ctx, { customerName: name, reason: details || "Caller asked for a callback", priority, type: "callback" });
      return more(`Thank you${name ? `, ${first(name)}` : ""}. I've asked a team member to call you back at this number.`);
    };

    const finishFlow = async (): Promise<AgentTurnResult> => {
      const flow = state.flow!;
      if (flow === "booking" || flow === "appointment" || flow === "lead") return completeLead(flow);
      if (flow === "service") return completeService();
      if (flow === "complaint") return completeCallback("high");
      return completeCallback();
    };

    const askNext = async (): Promise<AgentTurnResult> => {
      const { slots, flow } = state;
      if (flow === "service" && !slots.location) return say("Which room or location is this for?", { awaiting: "location" });
      if (flow !== "service" && !slots.name) return say("May I have your name, please?", { awaiting: "name" });
      return finishFlow();
    };

    const startFlow = async (flow: Flow, text: string): Promise<AgentTurnResult> => {
      state.flow = flow;
      state.slots = { details: text, name: extractName(text), location: extractLocation(text) };
      if (flow === "booking" && !(hasDateHint(text) && hasCountHint(text)))
        return say(
          hasDateHint(text)
            ? "Certainly. What time will you arrive, and how many guests will be staying?"
            : hasCountHint(text)
              ? "Certainly. Which dates would you like?"
              : "I can take a booking request for our team to confirm. What dates would you like, and how many guests?",
          { awaiting: "details" },
        );
      if (flow === "appointment" && !(hasDateHint(text) && hasTimeHint(text)))
        return say(
          hasDateHint(text)
            ? "Sure. What time works best for you, and what is the appointment for?"
            : "I can take an appointment request for our team to confirm. What day and time works best, and what is it for?",
          { awaiting: "details" },
        );
      if (flow === "lead" && text.split(/\s+/).length < 6)
        return say("I'd be happy to help. Could you tell me a little more about what you're looking for?", { awaiting: "details" });
      if (flow === "complaint" && text.split(/\s+/).length < 10)
        return say("I'm very sorry to hear that. Could you tell me what happened so I can make sure the right person follows up?", { awaiting: "details" });
      return askNext();
    };

    const transfer = async (): Promise<AgentTurnResult> => {
      const r = await runTool("request_human_transfer", ctx, { reason: "Caller asked to speak with a person" });
      const status = r.ok ? (r.data as { status: string }).status : "unavailable";
      if (status === "connecting") return say("Of course. Please hold while I connect you to our team.", {}, { transfer: true });
      if (status === "connected") return say("Of course. Connecting you to our team now.", {}, { end: true });
      state.flow = "callback";
      state.slots = { details: "Caller asked to speak with a person; nobody was available" };
      return say("I'm sorry, nobody on our team is available right now. May I take your name so they can call you back?", { awaiting: "name", flow: "callback" });
    };

    /** Queues ONE follow-up per call for questions we cannot verify. Returns true only if the backend confirmed it. */
    const queueUnverified = async (unanswered: string[]): Promise<boolean> => {
      if (state.callbackDeclined) return false;
      if (state.unverifiedNoted) return true;
      const r = await runTool("create_follow_up", ctx, { customerName: state.slots.name || undefined, reason: `Question the AI could not verify: "${unanswered.join("; ")}"`, priority: "normal", type: "callback" });
      if (r.ok) state.unverifiedNoted = true;
      return r.ok;
    };

    /** Adds one honest sentence for questions with no verified answer; claims a follow-up only if one was really created. */
    const withUnverifiedNote = async (spoken: string, unanswered: string[]): Promise<string> => {
      if (!unanswered.length) return spoken;
      const queued = await queueUnverified(unanswered);
      return `${spoken} I don't have the rest verified${queued ? ", so I've asked our team to follow up on it" : ""}.`.trim();
    };

    const answerQuestion = async (): Promise<AgentTurnResult> => {
      const rooms = await safeRooms(call.businessId);

      // 0. Several questions in one message: answer each from verified data, and flag only the ones that are not.
      if (splitQuestions(t).length > 1) {
        const found = answerQuestions(t, knowledge, rooms);
        if (found.answered.length) return more(await withUnverifiedNote(found.answered.map((a) => a.answer).join(" "), found.unanswered));
      }

      // 1. A verified statement that actually covers what was asked (FAQ, service, policy, live room rate).
      const hit = bestAnswer(t, knowledge, rooms);
      if (hit) return more(hit.source === "room" ? `${hit.answer} The total for your dates is confirmed when you book.` : hit.source === "service" && /\bprice|cost|how much|rate\b/i.test(t) ? `${hit.answer} Final pricing can be confirmed by our team.` : hit.answer);

      // 2. Opening hours: only when hours were actually asked about.
      if (/\b(hours?|open|opens|opening|close|closes|closing)\b/i.test(t)) {
        const i = await info("hours");
        if (i.hours) return more(`Our hours are ${i.hours}. ${i.openNow === false ? "We're currently closed." : ""}`.trim());
      }

      // 3. General pricing: never answer a question about something we have no verified price for (e.g. "what does the spa cost?") with some other price.
      if (intent === "pricing_question" || /\b(price|prices|pricing|rates?|cost|how much)\b/i.test(t)) {
        if (unknownTerms(t, knowledge, rooms.map((r) => r.name)).length === 0) {
          if (/\b(rooms?|stay|night)\b/i.test(t) && rooms.length) return more(`Our rooms: ${rooms.map((r) => `${r.name} at $${r.nightlyRate} per night`).join(", ")}.`);
          const i = await info("pricing", t);
          if (i.pricing) return more(`${i.pricing}`);
        }
      }

      // 4. Location.
      if (/\b(where|address|located|location|directions)\b/i.test(t) && business.address && unknownTerms(t, null, [business.address, business.name]).length === 0) return more(`We're located at ${business.address}.`);

      // 5. Not a question at all ("Maria Gomez", "ok", an email): say what we can do, never "I don't have that verified".
      if (!looksLikeQuestion(t) && (intent === "unknown" || intent === "general_question")) {
        return say(`I'm not sure what you'd like me to do with that. I can answer questions about ${business.name} or help with a reservation. What would you like?`);
      }
      // 6. Honest decline. Offer a callback once; never after it was declined, and never the same words twice in a row.
      const repeated = state.lastUnverified === t.toLowerCase();
      state.lastUnverified = t.toLowerCase();
      if (state.callbackDeclined || repeated) return more(repeated ? "I still don't have that verified, and I don't want to guess." : "I don't have that verified.");
      state.slots = { details: `Question the AI couldn't answer: "${t}"` };
      return say("I don't have that information verified. Would you like me to have someone from our team call you back?", { awaiting: "offer_callback" });
    };

    // ---- tool-backed multi-step workflows (reservations, payments …) take priority when they apply ----------
    {
      const wfResult = await handleWorkflows({ call, business, knowledge, state: state as never, text: t, intent });
      if (wfResult) return wfResult;
      if (call.agentState && (call.agentState as RuleState).wf && !state.wf) {
        // a workflow was abandoned (human request / urgent): fall through to the normal handler below
      }
    }

    // ---- interrupts that apply anywhere ---------------------------------------
    if (intent === "urgent_request" && state.awaiting !== "name") {
      state.slots = { details: t, location: extractLocation(t), urgent: true };
      state.flow = "service";
      await completeService();
      return say(
        "That sounds urgent. If anyone is in danger, please hang up and call 911. I've alerted our team and they will contact you right away. Is there anything else I should tell them?",
        { awaiting: "more", flow: undefined, slots: {} },
      );
    }
    if (intent === "human_request") return transfer();

    // ---- the caller asked something instead of answering: answer it, keep the unfinished request, then resume ----------
    if ((state.awaiting === "name" || state.awaiting === "details" || state.awaiting === "location") && looksLikeQuestion(t) && !["complaint"].includes(intent)) {
      const found = answerQuestions(t, knowledge, await safeRooms(call.businessId));
      const given = extractName(t); // "My name is John, and what time is check-out?"
      if (given && state.awaiting === "name") state.slots.name = given;
      let spoken = found.answered.map((a) => a.answer).join(" ");
      if (found.unanswered.length) {
        if (found.answered.length) spoken = await withUnverifiedNote(spoken, found.unanswered);
        else spoken = `I don't have that verified${(await queueUnverified(found.unanswered)) ? ", so I've asked our team to follow up on it" : ""}.`;
      }
      if (spoken) {
        const pending = state.awaiting;
        if (pending === "name" && state.slots.name) state.awaiting = undefined;
        const next = await askNext();
        // Resume the booking naturally, in different words than the first time.
        const resumed = state.awaiting === "name" ? "And may I have your name for it?" : state.awaiting === "location" ? "And which room or location is this for?" : next.reply;
        return { ...next, reply: `${spoken} ${resumed}`.trim() };
      }
    }

    // ---- answer to an outstanding question --------------------------------------
    switch (state.awaiting) {
      case "details":
        state.slots.details = `${state.slots.details ?? ""} ${t}`.trim();
        state.slots.name ??= extractName(t);
        state.slots.location ??= extractLocation(t);
        state.awaiting = undefined;
        return askNext();
      case "location":
        state.slots.location = extractLocation(t) ?? t.replace(/^(it'?s|its|it is)\s+/i, "").slice(0, 80);
        state.awaiting = undefined;
        return askNext();
      case "name": {
        const name = extractName(t, true);
        if (!name) {
          state.nameRetries = (state.nameRetries ?? 0) + 1;
          if (state.nameRetries < 2) return say("Sorry, I didn't catch your name. Could you say it again?");
        }
        state.slots.name = name ?? "Caller";
        state.awaiting = undefined;
        return finishFlow();
      }
      case "offer_callback":
        if (YES.test(t) && !NO.test(t)) {
          state.flow = "callback";
          return say("Certainly. May I have your name?", { awaiting: "name" });
        }
        if (NO.test(t) || BYE.test(t)) {
          state.callbackDeclined = true;
          return more("No problem.");
        }
        break; // neither yes nor no (e.g. a new question): treat it as a fresh request, the offer simply lapses
      case "more":
        if (BYE.test(t) || (NO.test(t) && intent === "unknown")) return say(FAREWELL(business), {}, { end: true });
        if (YES.test(t) && intent === "unknown") return say("Of course. What can I help you with?", { awaiting: undefined });
        break; // fall through to normal routing below
    }

    if (BYE.test(t) && !state.flow && intent === "unknown") return say(FAREWELL(business), {}, { end: true });

    // ---- route a fresh request -------------------------------------------------
    state.awaiting = undefined;

    // Info first: a question that verified data answers ("how much notice to reschedule?", "do you allow dogs?") must never
    // be mistaken for a booking / appointment / lead request just because it contains a trigger word.
    if ((/\?\s*$/.test(t) || /^(what|when|where|which|who|how|do|does|did|is|are|can|could|will|would)\b/i.test(t)) && !["urgent_request", "human_request", "complaint", "service_request", "existing_customer_question"].includes(intent)) {
      const rooms = await safeRooms(call.businessId);
      if (splitQuestions(t).length > 1) {
        const found = answerQuestions(t, knowledge, rooms);
        if (found.answered.length) return more(await withUnverifiedNote(found.answered.map((a) => a.answer).join(" "), found.unanswered));
      }
      const hit = bestAnswer(t, knowledge, rooms);
      if (hit) return more(hit.source === "room" ? `${hit.answer} The total for your dates is confirmed when you book.` : hit.answer);
    }
    switch (intent) {
      case "booking_inquiry":
        return startFlow("booking", t);
      case "appointment_request":
        return startFlow("appointment", t);
      case "sales_lead":
        return startFlow("lead", t);
      case "service_request":
        return startFlow("service", t);
      case "complaint":
        return startFlow("complaint", t);
      case "existing_customer_question": {
        const r = await runTool("lookup_existing_customer", ctx, {});
        const known = r.ok && (r.data as { found: boolean }).found;
        state.flow = "callback";
        state.slots = { details: `Existing customer question: ${t}` };
        return say(
          `${known ? "Thanks for calling back. " : ""}I can't access reservation or account details by phone, but I can have a team member call you back. May I have your name?`,
          { awaiting: "name", flow: "callback" },
        );
      }
      case "business_hours":
      case "pricing_question":
      case "general_question":
        return answerQuestion();
      default:
        if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(t) && t.split(/\s+/).length <= 4) return say("Hello! How can I help you today?");
        return answerQuestion();
    }
  }
}

/** Test helper / engine hook. */
export function ruleStateOf(call: CallDoc): RuleState {
  return { slots: {}, ...(call.agentState as Partial<RuleState>) };
}
