import { Call } from "../../models";
import { logger } from "../../config/logger";
import type { BusinessDoc, CallDoc, Intent, KnowledgeDoc } from "../../models";
import { runTool } from "../../tools/registry";
import { resolveRoom } from "../../tools/helpers";
import { getBookingProvider } from "../booking";
import type { BookingProvider, ReservationRecord } from "../booking";
import { localDateKey } from "../calls/businessHours";
import { addDays, diffDays, extractDates, parseStay, speakDate, wordToNumber } from "./dates";
import { ACK_ONLY, NO, extractCode, extractEmail, extractGuests, extractName, extractPhone, isNo, isYes, speakCode } from "./extract";
import { normalizePhone, speakPhone } from "../../utils/phone";
import { bestAnswer, unknownTerms } from "./knowledgeSearch";
import { answerQuestions, looksLikeQuestion, splitQuestions } from "./questions";
import type { AgentTurnResult } from "./types";

/**
 * Multi-step, tool-backed conversations for the built-in agent: reservations (book / change / cancel / look up),
 * payment requests, and early/late check requests. Rules this module never breaks:
 *   - nothing is called "confirmed / changed / cancelled" unless the tool result says so (and verified=true)
 *   - availability and prices come only from tool results
 *   - payments are never taken; they become a request for a human to approve
 *   - on any failure it says what it could not confirm and creates a callback follow-up
 */

export interface WfSlots {
  name?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  roomType?: string;
  phone?: string;
  email?: string;
  code?: string;
  lastName?: string;
  // modify
  newCheckIn?: string;
  newCheckOut?: string;
  newRoomType?: string;
  newGuests?: number;
  // payment
  payKind?: "charge" | "refund" | "adjustment";
  purpose?: string;
  amount?: number;
  // early/late request
  detail?: string;
  /** "two nights" heard before any date */
  nights?: number;
}

export interface Wf {
  kind: "reserve" | "modify" | "cancel" | "lookup" | "payment" | "stayrequest";
  slots: WfSlots;
  /** The question we're waiting on. */
  asked?: string;
  /** Same question asked this many times in a row without progress (noisy audio / unclear answers). */
  stuck: number;
  confirming?: boolean;
  /** Reservation as read back from the booking system after the caller was verified. */
  view?: ReservationRecord;
  unansweredQuestion?: boolean;
}

interface Input {
  call: CallDoc;
  business: BusinessDoc;
  knowledge: KnowledgeDoc | null;
  state: { wf?: Wf; awaiting?: string; flow?: string; slots: Record<string, unknown> } & Record<string, unknown>;
  text: string;
  intent: Intent;
}

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(n % 1 === 0 ? 0 : 2)}`;
const ABANDON = /\b(never ?mind|forget it|forget about it|scratch that|don'?t worry about it|leave it)\b/i;
const QUESTION_START = /^(what|when|where|which|who|how|do you|does|is there|are there|can i|could i|will|would)\b/i;
const INFO_INTENTS: Intent[] = ["business_hours", "pricing_question", "general_question"];

const PAYMENT_REQUEST =
  /\b(i('d| would)? (like|want|need) to|can (you|i)|could (you|i)|please|let me|go ahead and|i('m| am) (ready|going) to|want to)\b[^.?!]*\b(pay|payment|deposit|charge|refund|reimburse)\b|\b(refund(ed)?|money back|chargeback|reimburs\w*)\b|\bcharge my (card|credit)\b|\bpay (now|by card|with (my )?card)\b/i;
const EARLY_LATE = /\b(early\s+check-?\s?in|late\s+check-?\s?out|check(ing)?\s+in\s+early|check(ing)?\s+out\s+late|check-?\s?in\s+(at|around|before)\s+\d|check-?\s?out\s+(at|around|after)\s+\d)\b/i;
const REQUEST_PHRASE = /\b(can|could|may|would it be possible|is it possible|i('d| would) like|i need|i want|please|we('d| would) like)\b/i;
const CANCEL_WORD = /\bcancel\b/i;
const NOT_A_POLICY_Q = /\bcancell?ation (policy|policies|fee|fees|terms)\b/i;
/** Things a business phone assistant never does; say so honestly instead of improvising. */
const OUT_OF_SCOPE = /\b(flights?|airline|plane tickets?|rental car|car rental|taxi|uber|lyft|train tickets?|visa|passport|insurance claim|stocks?|crypto|loan|lawyer|legal advice|tax advice)\b/i;
const DECLINE_CALLBACK = /\b(no|don'?t|do not|not)\b[^.?!]*\b(call ?back|call me|callback|follow[- ]?up|ring me)\b/i;
/** "no, I don't want a callback" with nothing else in it. */
const DECLINE_ONLY = /^\s*(no|nope|no thanks?|no thank you)?[\s,.]*(i\s+)?(don'?t|do not|no need|there'?s no need)\b[^.?!]*\b(call ?back|call me|callback|follow[- ]?up)[^.?!]*[.!]?\s*$|^\s*no\s+call ?back[.!\s]*$/i;
const PRICE_Q = /\b(total|tax|taxes|fees?|price|cost|how much|rate|rates|charge|per night)\b/i;
const LODGING_WORDS = /\b(room|rooms|suite|stay|stays|staying|night|nights|reservation|accommodation|lodging)\b/i;

export const wfActive = (state: Input["state"]) => !!state.wf;

/** Wraps the workflow engine so an unexpected error (booking system down, bad data…) becomes a safe, honest fallback. */
export async function handleWorkflows(i: Input): Promise<AgentTurnResult | null> {
  try {
    return await runWorkflows(i);
  } catch (e) {
    logger.error("Workflow failed; falling back to a human callback", { message: (e as Error).message });
    const s = (i.state.wf?.slots ?? {}) as WfSlots;
    const ctx = { businessId: i.call.businessId, callId: i.call._id };
    const captured = [s.name && `name ${s.name}`, s.checkIn && `check-in ${s.checkIn}`, s.checkOut && `check-out ${s.checkOut}`, s.guests && `${s.guests} guest(s)`, s.roomType && `room ${s.roomType}`, s.code && `code ${s.code}`].filter(Boolean).join(", ");
    await runTool("create_follow_up", ctx, { customerName: s.name, reason: `A system error interrupted this request, so nothing was confirmed to the caller.${captured ? ` Captured so far: ${captured}.` : ""} Please call them back.`, priority: "high", type: "callback" });
    i.state.wf = undefined;
    i.state.awaiting = "more";
    await Call.updateOne({ _id: i.call._id }, { $set: { agentState: i.state }, $inc: { "metrics.brainErrors": 1 } });
    return { reply: "I'm sorry, I ran into a problem and I wasn't able to complete that, and I don't want to promise something I can't confirm. I've asked our team to call you back at this number. Is there anything else I can help you with?", end: false, transfer: false };
  }
}

async function runWorkflows(i: Input): Promise<AgentTurnResult | null> {
  const { call, business, state } = i;
  const text = i.text.trim();
  const ctx = { businessId: call.businessId, callId: call._id };
  const today = localDateKey(new Date(), business.timezone);
  const provider = await getBookingProvider(call.businessId);
  const prov_rooms = async () => {
    try {
      return provider ? await provider.listRoomTypes(call.businessId) : [];
    } catch {
      return []; // side questions must not depend on the booking system being up
    }
  };

  const persist = () => Call.updateOne({ _id: call._id }, { $set: { agentState: state } });
  const reply = async (say: string, extra: Partial<AgentTurnResult> = {}): Promise<AgentTurnResult> => {
    await persist();
    return { reply: say, end: false, transfer: false, ...extra };
  };
  /** Finish the workflow and hand back to normal conversation ("anything else?"). */
  const done = async (say: string) => {
    state.wf = undefined;
    state.awaiting = "more";
    state.flow = undefined;
    state.slots = {};
    return reply(`${say} Is there anything else I can help you with?`);
  };
  /** Safe fallback: say what could NOT be confirmed and make sure a human follows up. Never pretend success. */
  const fallback = async (what: string, wf?: Wf) => {
    const s = wf?.slots ?? {};
    const captured = [s.name && `name ${s.name}`, s.checkIn && `check-in ${s.checkIn}`, s.checkOut && `check-out ${s.checkOut}`, s.guests && `${s.guests} guest(s)`, s.roomType && `room ${s.roomType}`, s.code && `code ${s.code}`].filter(Boolean).join(", ");
    await runTool("create_follow_up", ctx, {
      customerName: s.name,
      reason: `${what}${captured ? ` Captured so far: ${captured}.` : ""} Nothing was confirmed to the caller; please call them back.`,
      priority: "high",
      type: "callback",
    });
    return done(`I'm sorry, I wasn't able to complete that, and I don't want to promise something I can't confirm. ${what.includes("booking system") ? "I haven't changed or booked anything. " : ""}I've asked our team to call you back at this number.`);
  };

  const ask = async (wf: Wf, field: string, question: string): Promise<AgentTurnResult> => {
    wf.stuck = wf.asked === field ? wf.stuck + 1 : 0;
    wf.asked = field;
    if (wf.stuck >= 3) return fallback(`The caller could not be understood while giving their ${field.replace(/_/g, " ")} (${wf.kind}).`, wf);
    state.wf = wf;
    return reply(question);
  };

  // ---------- verified terms the agent may quote ------------------------------------------------------------
  const booking = (i.knowledge as unknown as { booking?: { taxRatePercent?: number | null; depositPolicy?: string; depositPercent?: number } } | null)?.booking;
  const cancellationText = () => bestAnswer("What is the cancellation policy?", i.knowledge, [])?.answer ?? null;
  /** Tax wording for a room subtotal. Never guesses: with no verified tax rate it says so. */
  const taxLine = (subtotal?: number) => {
    const rate = booking?.taxRatePercent;
    if (rate == null) return "I don't have taxes and fees verified, so the front desk confirms the final amount.";
    if (subtotal == null) return `Taxes are ${rate}%.`;
    const tax = Math.round(subtotal * rate) / 100;
    return `Taxes at ${rate}% add ${money(tax)}, for ${money(Math.round((subtotal + tax) * 100) / 100)} in total.`;
  };
  const depositAmount = (total: number) => (booking?.depositPercent ? Math.round(total * booking.depositPercent) / 100 : undefined);

  /** Price / tax / total question during a reservation: answered from live availability for the dates already given. */
  const quoteInContext = async (wf: Wf): Promise<string | null> => {
    if (wf.kind !== "reserve" || !provider) return null;
    const s = wf.slots;
    if (!s.checkIn || !s.checkOut) {
      const rooms = await prov_rooms();
      if (!rooms.length) return null;
      return `Our rooms are ${rooms.map((r) => `${r.name} at ${money(r.nightlyRate)} per night`).join(", ")}, before taxes and fees. ${taxLine()}`;
    }
    const av = await runTool("check_availability", ctx, { checkIn: s.checkIn, checkOut: s.checkOut, guests: s.guests ?? 1 });
    const d = av.ok ? (av.data as { verified: boolean; rooms?: { roomType: string; roomsAvailable: number; nightlyRate: number; totalForStay: number }[] }) : null;
    if (!d?.verified) return null;
    const nights = diffDays(s.checkIn, s.checkOut);
    const rooms = (d.rooms ?? []).filter((r) => r.roomsAvailable > 0 && (!s.roomType || r.roomType === s.roomType));
    if (!rooms.length) return null;
    const lines = rooms.slice(0, 3).map((r) => `${r.roomType} is ${money(r.nightlyRate)} per night, ${money(r.totalForStay)} for ${nights} ${nights === 1 ? "night" : "nights"} before taxes`);
    return `${lines.join("; ")}. ${taxLine(rooms.length === 1 ? rooms[0].totalForStay : undefined)}`;
  };

  /** Queue ONE follow-up per call for something we could not verify: never after the caller declined a callback, and only reported if it really exists. */
  const queueUnverified = async (wf: Wf, what: string): Promise<boolean> => {
    if (state.callbackDeclined) return false;
    if (wf.unansweredQuestion) return true;
    const q = await runTool("create_follow_up", ctx, { customerName: wf.slots.name || undefined, reason: `Question the AI could not verify during a ${wf.kind} request: "${what.slice(0, 300)}"`, priority: "normal", type: "callback" });
    wf.unansweredQuestion = q.ok;
    return q.ok;
  };

  // ---------- answer info questions without losing our place ------------------------------------------------
  const sideAnswer = async (wf: Wf): Promise<string> => {
    const rooms = await prov_rooms();
    const pieces = splitQuestions(text);
    const answered: string[] = [];
    const unanswered: string[] = [];
    const rest: string[] = [];
    for (const piece of pieces) {
      if (PRICE_Q.test(piece)) {
        const q = await quoteInContext(wf);
        if (q) { if (!answered.includes(q)) answered.push(q); continue; }
      }
      rest.push(piece);
    }
    if (rest.length) {
      const found = answerQuestions(rest.join(". "), i.knowledge, rooms);
      answered.push(...found.answered.map((a) => a.answer).filter((a) => !answered.includes(a)));
      unanswered.push(...found.unanswered);
    }
    if (!answered.length && !unanswered.length) unanswered.push(text);
    if (!unanswered.length) return answered.join(" ");
    const queued = await queueUnverified(wf, unanswered.join("; "));
    const miss = `I don't have ${answered.length ? "the rest" : "that"} verified${queued ? ", so I've asked our team to follow up on it" : ""}.`;
    return [...answered, miss].join(" ");
  };

  // ======================= the caller declines a callback ==================================================
  if (DECLINE_CALLBACK.test(text)) {
    state.callbackDeclined = true;
    if (DECLINE_ONLY.test(text)) {
      const w = state.wf;
      if (w) return reply(`No problem, I won't arrange a callback. ${await resume(w)}`);
      if (state.awaiting === "name") return reply("No problem, I won't arrange a callback. May I have your name for the request?");
      state.awaiting = "more";
      state.slots = {};
      return reply("No problem, I won't arrange a callback. Is there anything else I can help you with?");
    }
  }

  // ======================= continue an active workflow ======================================================
  const wf = state.wf;
  if (wf) {
    if (i.intent === "human_request" || i.intent === "urgent_request") {
      state.wf = undefined; // let the main handler transfer / escalate; the partial request is kept as a follow-up at call end
      await persist();
      return null;
    }
    if (ABANDON.test(text)) return done("No problem, I've stopped that.");

    const askedQuestion = (QUESTION_START.test(text) || looksLikeQuestion(text)) && !extractDates(text, today).dates.length;
    const picksRoom = wf.kind === "reserve" && wf.asked === "room" && !!resolveRoom(await prov_rooms(), text).match;
    const isInfoQuestion = askedQuestion && !picksRoom && (INFO_INTENTS.includes(i.intent) || PRICE_Q.test(text) || answerQuestions(text, i.knowledge, await prov_rooms()).answered.length > 0);
    if (isInfoQuestion) {
      const ans = await sideAnswer(wf);
      // Resume briefly: never re-read the whole confirmation summary or re-ask a question the way it was first asked.
      const again =
        wf.asked === "confirm" ? (wf.kind === "reserve" ? "So, shall I go ahead and book it?" : "So, shall I go ahead and make that change?")
        : wf.asked === "name" ? "And may I have a name for it?"
        : wf.asked === "room" ? "Which room would you like?"
        : await resume(wf);
      return reply(`${ans} ${again}`);
    }
    return step(wf, text);
  }

  // ======================= start a workflow ==================================================================
  const lower = text.toLowerCase();
  const code = extractCode(text);

  if (OUT_OF_SCOPE.test(text) && i.intent !== "urgent_request") {
    state.awaiting = "offer_callback";
    state.slots = { details: `Request outside what the AI handles: "${text.slice(0, 200)}"` };
    return reply(`I'm sorry, I can't help with that one, and I don't want to guess. I can help with ${business.name} questions, bookings and requests. Would you like a team member to call you back about it?`);
  }

  if (PAYMENT_REQUEST.test(text)) {
    const kind = /\b(refund\w*|money back|reimburs\w*)\b/i.test(lower) ? "refund" : "charge";
    const w: Wf = { kind: "payment", stuck: 0, slots: { payKind: kind, purpose: text, code, name: extractName(text) } };
    return step(w, "", true);
  }

  if (EARLY_LATE.test(text) && REQUEST_PHRASE.test(text) && !/^(what|when)\b/i.test(text)) {
    const w: Wf = { kind: "stayrequest", stuck: 0, slots: { detail: text, name: extractName(text), code } };
    return step(w, "", true);
  }

  if (provider) {
    const IMPERATIVE = /\b(i (want|need|would like|'d like|wish) to|i'?m calling to|please|let'?s|go ahead and|can you|could you|help me)\b/i.test(lower) || !!code;
    const POLICY_Q = /\b(for free|free of charge|fee|fees|charge|penalty|policy|policies|how late|how long|what if|what happens|deadline|refundable)\b/i.test(lower) && !code;
    const wantsCancel = CANCEL_WORD.test(text) && !NOT_A_POLICY_Q.test(text) && !POLICY_Q && IMPERATIVE && (/\b(reservation|booking|stay|room)\b/i.test(lower) || !!code);
    const wantsChange = /\b(change|modify|move|extend|shorten|reschedule|update|switch|push back)\b/i.test(lower) && !POLICY_Q && (/\b(reservation|booking|stay|dates?|room|nights?)\b/i.test(lower) || !!code);
    const wantsLookup = !!code || (!POLICY_Q && /\b(check|status|details|look ?up|find|confirm)\b[^.?!]*\b(reservation|booking)\b/i.test(lower));
    if (wantsCancel) return step({ kind: "cancel", stuck: 0, slots: { code, lastName: lastNameFrom(text) } }, "", true);
    if (wantsChange) return step({ kind: "modify", stuck: 0, slots: { code, lastName: lastNameFrom(text) } }, text, true);
    if (wantsLookup) return step({ kind: "lookup", stuck: 0, slots: { code, lastName: lastNameFrom(text) } }, "", true);
    const bookingWords = /\b(book|reserve|reservation|availab|vacanc)/i.test(lower) && (LODGING_WORDS.test(lower) || /\b(deluxe|suite|king|queen|family room|ocean)\b/i.test(lower));
    const infoQuestion = QUESTION_START.test(text) && !/^(do you have|can i|could i)\b/i.test(text);
    const unknownTopic = /^(do you have|is there|are there)\b/i.test(text) && unknownTerms(text, i.knowledge, (await prov_rooms()).map((r) => r.name)).length > 0;
    const wantsRoom = !infoQuestion && !unknownTopic && !/\b(out of (the|our|my) room|check-?\s?out|leave the room)\b/i.test(lower) && /\b(i('d| would)? (like|want|need)|looking for|do you have|can i (get|have)|we need|we want)\b[^.?!]*\b(room|rooms|suite|stay)\b/i.test(lower);
    const availabilityAsk = i.intent === "booking_inquiry" && /\b(availab\w*|vacanc\w*|any rooms?)\b/i.test(lower);
    const bareLodging = i.intent === "booking_inquiry" && LODGING_WORDS.test(lower); // "kingg room tomorrow 2 nights" (no verb) is still a booking request
    const policyQuestion = (QUESTION_START.test(text) || /^(can|could|is|are|do|does|will)\b/i.test(text.trim())) && !/\b(book|reserve)\b/i.test(lower) && !extractDates(text, today).dates.length && !!bestAnswer(text, i.knowledge, await prov_rooms());
    if (policyQuestion) return null; // a plain knowledge question: answer it, don't start a booking
    if ((wantsRoom || bareLodging || availabilityAsk || (i.intent === "booking_inquiry" && bookingWords)) && !(QUESTION_START.test(text) && /\bcheck-?\s?(in|out)\b/i.test(lower))) {
      return step({ kind: "reserve", stuck: 0, slots: {} }, text, true);
    }
  }
  return null; // not a workflow: normal conversation handles it

  // ====================================================================================================
  function lastNameFrom(t: string): string | undefined {
    const m = t.match(/\b(?:last name is|surname is|under the name|name is|it'?s|i'?m|this is)\s+(?:[a-z]+\s+)?([a-z][a-z'’-]+)\s*$/i);
    return m ? m[1] : undefined;
  }

  /** Re-ask whatever question we were in the middle of (after answering a side question). */
  async function resume(w: Wf): Promise<string> {
    const keep = { asked: w.asked, stuck: w.stuck };
    const r = await step(w, "", false, true);
    w.asked = keep.asked; // re-asking after a side question is not a failed attempt
    w.stuck = keep.stuck;
    return r.reply;
  }

  async function step(w: Wf, utterance: string, starting = false, dryRun = false): Promise<AgentTurnResult> {
    switch (w.kind) {
      case "reserve":
        return reserveStep(w, utterance, starting, dryRun);
      case "modify":
      case "cancel":
      case "lookup":
        return manageStep(w, utterance, starting, dryRun);
      case "payment":
        return paymentStep(w, utterance, starting, dryRun);
      case "stayrequest":
        return stayRequestStep(w, utterance, starting, dryRun);
    }
  }

  // ======================= RESERVE ===========================================================================
  async function reserveStep(w: Wf, utt: string, starting: boolean, dry: boolean): Promise<AgentTurnResult> {
    const s = w.slots;
    const prov = provider as BookingProvider;
    let slotsBefore = JSON.stringify(s);

    if (!dry && utt) {
      // yes / no on the confirmation question
      if (w.asked === "confirm") {
        if (isYes(utt)) return bookNow(w);
        if (isNo(utt)) {
          w.confirming = false;
          return ask(w, "change", "No problem. What would you like to change: the dates, the room, or the number of guests?");
        }
        const volunteered = extractEmail(utt) || extractPhone(utt);
        if (volunteered && !parseStay(utt, today).checkIn) {
          if (extractEmail(utt)) s.email = extractEmail(utt);
          if (extractPhone(utt)) s.phone = extractPhone(utt);
          return reply("Thanks, I've noted that. Shall I go ahead and book it?");
        }
      }
      // The caller is answering with "ok" / "book it" / "no" instead of giving what we asked for: acknowledge it, keep the booking, ask again.
      if (w.asked === "name" && !extractName(utt, true)) {
        if (ACK_ONLY.test(utt)) return reply("Happy to. First, may I have the name for the reservation?");
        if (isNo(utt) && utt.trim().split(/\s+/).length <= 5 && !extractName(utt)) return reply("No problem. I just need a name for the reservation, or we can stop here.");
      }
      const em = extractEmail(utt);
      if (em) s.email = em;
      if (w.asked === "phone" || w.asked === "phone2") {
        const ph = extractPhone(utt);
        if (ph) s.phone = ph;
        else if (w.asked === "phone" && (isYes(utt) || /\b(that|this|same|current|calling from|use it)\b/i.test(utt))) s.phone = normalizePhone(call.callerNumber) || undefined;
        else if (w.asked === "phone" && isNo(utt)) return ask(w, "phone2", "What number should I use for the reservation?");
      } else {
        const ph = extractPhone(utt);
        if (ph && /\b(number|phone|reach|call me)\b/i.test(utt)) s.phone = ph;
      }
      slotsBefore = JSON.stringify(s);
      const stay = parseStay(utt, today);
      const replacing = ["alt", "change", "confirm"].includes(w.asked ?? "");
      if (stay.inPast) {
        return ask(w, "dates", "That date has already passed. Which upcoming dates would you like?");
      }
      if (stay.checkIn && (replacing || !s.checkIn)) {
        s.checkIn = stay.checkIn;
        s.checkOut = stay.checkOut ?? (stay.nights ? addDays(stay.checkIn, stay.nights) : undefined);
      } else if (stay.checkIn && s.checkIn && !s.checkOut && stay.checkIn > s.checkIn) {
        s.checkOut = stay.checkIn; // "...and leaving the 20th"
      } else if (stay.nights && s.checkIn && !stay.checkIn) {
        s.checkOut = addDays(s.checkIn, stay.nights);
      } else if (stay.nights && !s.checkIn && !stay.checkIn) {
        s.nights = stay.nights; // remembered until we hear the dates
      }
      if (s.nights && s.checkIn && !s.checkOut) {
        s.checkOut = addDays(s.checkIn, s.nights);
        s.nights = undefined;
      }
      if (stay.ambiguous && !s.checkIn) return ask(w, "dates", "I want to make sure I get the dates right. Which exact check-in and check-out dates would you like?");
      if (stay.ambiguous && stay.checkIn && !stay.checkOut && !s.checkOut) w.asked = "nights";

      const g = extractGuests(utt, w.asked === "guests");
      if (g) s.guests = g;
      const nm = extractName(utt, w.asked === "name");
      if (nm && (w.asked === "name" || /name/i.test(utt))) s.name = nm;
      else if (nm && !s.name) s.name = nm;

      const options = await prov.listRoomTypes(call.businessId);
      const rt = resolveRoom(options, utt);
      if (rt.match && (w.asked === "room" || w.asked === "change" || !s.roomType || /\b(room|suite|king|queen|deluxe|ocean|family|view|double|single)\b/i.test(utt))) s.roomType = rt.match.name;
      else if (rt.ambiguous && w.asked === "room") {
        return ask(w, "room", `Which one would you like: ${rt.ambiguous.map((o) => o.name).join(" or ")}?`);
      }
      if (w.asked === "change" && !stay.checkIn && !g && !rt.match) {
        if (/\b(date|dates|day|days)\b/i.test(utt)) { s.checkIn = undefined; s.checkOut = undefined; return ask(w, "dates", "Sure. What dates would you like instead?"); }
        if (/\b(guest|guests|people|persons)\b/i.test(utt)) { s.guests = undefined; return ask(w, "guests", "How many guests will be staying?"); }
        if (/\b(room|suite)\b/i.test(utt)) { s.roomType = undefined; w.confirming = false; }
      }
    }

    // The caller gave us something new (changed the dates, the room...): that is progress, not a failed attempt at the last question.
    if (!dry && utt && JSON.stringify(s) !== slotsBefore) { w.asked = "progress"; w.stuck = 0; }

    // ---- what is still missing? ask exactly one clear question ----
    if (!s.checkIn) return ask(w, "dates", starting ? "I'd be happy to help with a reservation. What dates would you like to check in and check out?" : "Which dates would you like?");
    if (!s.checkOut) return ask(w, "nights", `Got it, arriving ${speakDate(s.checkIn)}. How many nights will you stay?`);
    if (diffDays(s.checkIn, s.checkOut) < 1) { s.checkOut = undefined; return ask(w, "nights", "Check-out has to be after check-in. How many nights will you stay?"); }
    if (!s.guests) return ask(w, "guests", "How many guests will be staying?");

    const av = await runTool("check_availability", ctx, { checkIn: s.checkIn, checkOut: s.checkOut, guests: s.guests });
    if (!av.ok) return fallback("The booking system could not be reached to check availability.", w);
    const data = av.data as { verified: boolean; message?: string; rooms?: { roomType: string; roomsAvailable: number; nightlyRate: number; totalForStay: number; sleeps: number }[] };
    if (!data.verified) {
      s.checkIn = s.checkOut = undefined;
      return ask(w, "dates", `${(data.message ?? "").includes("past") ? "Those dates have already passed. " : ""}Let's pick the dates again. Which check-in and check-out dates would you like?`);
    }
    const available = (data.rooms ?? []).filter((r) => r.roomsAvailable > 0);
    const nights = diffDays(s.checkIn, s.checkOut);
    if (!available.length) {
      w.confirming = false;
      s.checkIn = s.checkOut = undefined;
      s.roomType = undefined;
      return ask(w, "alt", `I'm sorry, we have no rooms available for ${nights === 1 ? "that night" : "those dates"}. Would you like to try different dates?`);
    }
    if (s.roomType) {
      const chosen = (data.rooms ?? []).find((r) => r.roomType === s.roomType);
      if (!chosen || chosen.roomsAvailable < 1) {
        const alt = available.map((r) => `${r.roomType} at ${money(r.nightlyRate)} per night`).join(", ");
        s.roomType = undefined;
        return ask(w, "room", `I'm sorry, ${chosen ? chosen.roomType : "that room"} isn't available for those dates. Available: ${alt}. Which would you like?`);
      }
    } else if (available.length === 1) {
      s.roomType = available[0].roomType;
    } else {
      const list = available.slice(0, 4).map((r) => `${r.roomType} at ${money(r.nightlyRate)} per night`).join(", ");
      return ask(w, "room", `For ${speakDate(s.checkIn)} to ${speakDate(s.checkOut)}, I can offer: ${list}. Which would you like?`);
    }
    if (!s.name) return ask(w, "name", w.asked === "name" && !dry ? "Sorry, I didn't catch that. Could you spell the name for me?" : "May I have the name for the reservation?");
    if (!s.phone) {
      // The number they are calling from is the default contact; it is read back in the confirmation so they can correct it.
      const cn = normalizePhone(call.callerNumber);
      if (cn.replace(/\D/g, "").length >= 10) s.phone = cn;
      else return ask(w, "phone", "What's the best phone number for the reservation?");
    }

    const room = (data.rooms ?? []).find((r) => r.roomType === s.roomType)!;
    w.confirming = true;
    w.asked = "confirm";
    w.stuck = 0;
    state.wf = w;
    const deposit = depositAmount(room.totalForStay);
    const depositText =
      booking?.depositPolicy === "after_booking" ? ` A deposit${deposit ? ` of ${money(deposit)}` : ""} is required after booking. I can't take card details on this call, so I'd send a secure payment request to our team.`
      : booking?.depositPolicy === "to_confirm" ? ` A deposit${deposit ? ` of ${money(deposit)}` : ""} is required before the reservation can be confirmed. I can't take card details on this call, so I'd send a secure payment request to our team, and nothing is confirmed until they receive it.`
      : "";
    const cancel = cancellationText();
    return reply(
      `To confirm: ${room.roomType} for ${s.guests} ${s.guests === 1 ? "guest" : "guests"}, ${speakDate(s.checkIn)} to ${speakDate(s.checkOut)}, ${nights} ${nights === 1 ? "night" : "nights"}, ${money(room.nightlyRate)} per night, ${money(room.totalForStay)} before taxes. ${taxLine(room.totalForStay)} ${cancel ? `Cancellation: ${cancel}` : "I don't have the cancellation terms verified."}${depositText} Under the name ${s.name}. I'll use ${speakPhone(s.phone)} as the contact number; tell me if you'd like a different one. Shall I ${booking?.depositPolicy === "to_confirm" ? "send that request" : "book it"}?`,
    );
  }

  async function bookNow(w: Wf): Promise<AgentTurnResult> {
    const s = w.slots;
    const stayText = `${s.roomType}, ${speakDate(s.checkIn!)} to ${speakDate(s.checkOut!)}, ${s.guests} guest(s)`;

    // Deposit required BEFORE confirming: nothing is reserved. The request goes to staff and the caller is told exactly that.
    if (booking?.depositPolicy === "to_confirm") {
      const total = (await quoteTotal(w)) ?? undefined;
      const lead = await runTool("create_booking_or_lead", ctx, { type: "booking", customerName: s.name, customerPhone: s.phone, customerEmail: s.email, details: `Reservation request (deposit required first): ${stayText}`, estimatedValue: total });
      const pay = await runTool("request_payment_approval", ctx, { kind: "charge", amount: total ? depositAmount(total) : undefined, description: `Deposit to confirm a reservation: ${stayText}`, customerName: s.name });
      if (!lead.ok || !pay.ok) return fallback("The booking request and its secure payment request could not both be recorded.", w);
      return done(`I can't confirm this reservation until the deposit is received. I've recorded your request and sent a secure payment request to our team, who will contact you with a payment link. Nothing is confirmed and no payment has been taken.`);
    }

    const r = await runTool("create_reservation", ctx, { guestName: s.name, guestPhone: s.phone, guestEmail: s.email, roomType: s.roomType, checkIn: s.checkIn, checkOut: s.checkOut, guests: s.guests });
    if (!r.ok) return fallback(`The booking system did not confirm the reservation (${r.error.message}).`.replace(/\.\)\.$/, ".)"), w);
    const d = r.data as { confirmed: boolean; verified?: boolean; reason?: string; confirmationCode?: string; roomType?: string; totalAmount?: number; alternatives?: { roomType: string }[] };
    if (d.confirmed && d.verified && d.confirmationCode) {
      const base = `Your reservation is confirmed. Your confirmation code is ${speakCode(d.confirmationCode)}. That's ${d.roomType}, ${speakDate(s.checkIn!)} to ${speakDate(s.checkOut!)}, ${money(d.totalAmount ?? 0)} before taxes.`;
      if (booking?.depositPolicy === "after_booking") {
        const amount = depositAmount(d.totalAmount ?? 0);
        const pay = await runTool("request_payment_approval", ctx, { kind: "charge", amount, description: `Deposit for reservation ${d.confirmationCode}`, reservationCode: d.confirmationCode, customerName: s.name });
        return done(pay.ok
          ? `${base} A deposit${amount ? ` of ${money(amount)}` : ""} is due. I can't take card details on this call, so I've sent a secure payment request to our team and they will send you a payment link. No payment has been taken.`
          : `${base} A deposit is due, but I couldn't send the payment request, so please contact the front desk to arrange it. No payment has been taken.`);
      }
      return done(`${base} No payment has been taken.`);
    }
    if (d.reason === "unavailable") {
      w.confirming = false;
      s.roomType = undefined;
      const alt = d.alternatives?.length ? ` I can still offer ${d.alternatives.map((a) => a.roomType).join(" or ")}.` : "";
      return ask(w, "room", `I'm sorry, that room was just taken, so I haven't booked anything.${alt} Which would you like, or would you like different dates?`);
    }
    return fallback("The booking could not be confirmed by the booking system.", w);
  }

  /** Room-only total for the chosen stay, from live availability (never from memory of an earlier quote). */
  async function quoteTotal(w: Wf): Promise<number | null> {
    const s = w.slots;
    const av = await runTool("check_availability", ctx, { checkIn: s.checkIn, checkOut: s.checkOut, guests: s.guests });
    const room = av.ok ? ((av.data as { rooms?: { roomType: string; totalForStay: number }[] }).rooms ?? []).find((r) => r.roomType === s.roomType) : null;
    return room?.totalForStay ?? null;
  }

  // ======================= MODIFY / CANCEL / LOOKUP ============================================================
  async function manageStep(w: Wf, utt: string, starting: boolean, dry: boolean): Promise<AgentTurnResult> {
    const s = w.slots;
    const prov = provider as BookingProvider;
    if (!dry && utt) {
      s.code ??= extractCode(utt);
      if (w.asked === "code" && !s.code) s.code = extractCode(utt);
      if (w.asked === "lastname") s.lastName = extractName(utt, true)?.split(" ").pop() ?? utt.replace(/[^a-z'’-]/gi, " ").trim().split(/\s+/).pop();
      s.lastName ??= lastNameFrom(utt);

      if (w.asked === "confirm") {
        if (isYes(utt)) return applyManage(w);
        if (isNo(utt)) return done("Okay, I haven't changed anything.");
      }
      if (w.kind === "modify" && w.view) {
        const view = w.view;
        const stay = parseStay(utt, today);
        const lowerUtt = utt.toLowerCase();
        const extra = lowerUtt.match(/\b(extend|add|one more|another|an extra|stay)\b(?:[^.?!]*?\b(\d+|one|two|three|four|five)\b)?[^.?!]*?\bnights?\b/);
        const fewer = lowerUtt.match(/\b(shorten|one less|remove|drop|leave early|cut)\b(?:[^.?!]*?\b(\d+|one|two|three)\b)?[^.?!]*?\bnights?\b/);
        if (stay.checkIn && stay.checkOut) { s.newCheckIn = stay.checkIn; s.newCheckOut = stay.checkOut; }
        else if (stay.checkIn) { s.newCheckIn = stay.checkIn; s.newCheckOut = addDays(stay.checkIn, view.nights); }
        else if (extra) s.newCheckOut = addDays(s.newCheckOut ?? view.checkOut, wordToNumber(extra[2] ?? "one") ?? 1);
        else if (fewer) s.newCheckOut = addDays(s.newCheckOut ?? view.checkOut, -(wordToNumber(fewer[2] ?? "one") ?? 1));
        else if (stay.nights) s.newCheckOut = addDays(s.newCheckIn ?? view.checkIn, stay.nights);
        const g = extractGuests(utt, w.asked === "changes");
        if (g) s.newGuests = g;
        const rt = resolveRoom(await prov.listRoomTypes(call.businessId), utt);
        if (rt.match && rt.match.name !== view.roomTypeName) s.newRoomType = rt.match.name;
      }
    }

    if (!s.code) return ask(w, "code", starting ? `I can help with that. Please read me your confirmation code. It starts with S D.` : "Could you read me the confirmation code again? It starts with S D.");

    if (!w.view) {
      const r = await runTool("lookup_reservation", ctx, { confirmationCode: s.code, guestLastName: s.lastName });
      if (!r.ok) return fallback(`The booking system could not be reached to look up reservation ${s.code}.`, w);
      const d = r.data as { done: boolean; reason?: string } & Partial<ReservationRecord> & { roomType?: string };
      if (d.done) {
        w.view = { ...(d as unknown as ReservationRecord), roomTypeName: d.roomType ?? "" } as ReservationRecord;
      } else if (d.reason === "not_found") {
        s.code = undefined;
        return ask(w, "code", "I couldn't find a reservation with that code. Could you read it to me again?");
      } else if (!s.lastName) {
        return ask(w, "lastname", "To protect your reservation, what is the last name on it?");
      } else {
        return fallback("The caller could not be verified as the guest on a reservation, so it was not shown or changed.", w);
      }
    }
    const v = w.view!;

    if (w.kind === "lookup") {
      return done(`I found it. ${v.roomTypeName}, ${speakDate(v.checkIn)} to ${speakDate(v.checkOut)}, ${v.nights} ${v.nights === 1 ? "night" : "nights"}, ${v.guests} ${v.guests === 1 ? "guest" : "guests"}, ${money(v.totalAmount)} total. The status is ${v.status}.`);
    }
    if (v.status === "cancelled") return done("That reservation has already been cancelled.");

    if (w.kind === "cancel") {
      w.confirming = true;
      w.asked = "confirm";
      w.stuck = 0;
      state.wf = w;
      return reply(`I found ${v.roomTypeName}, ${speakDate(v.checkIn)} to ${speakDate(v.checkOut)}. Just to be sure, would you like me to cancel it?`);
    }

    // modify
    const changed = s.newCheckIn || s.newCheckOut || s.newRoomType || s.newGuests;
    if (!changed) return ask(w, "changes", `I found ${v.roomTypeName}, ${speakDate(v.checkIn)} to ${speakDate(v.checkOut)}. What would you like to change: the dates, the room, or the number of guests?`);
    const newIn = s.newCheckIn ?? v.checkIn;
    const newOut = s.newCheckOut ?? v.checkOut;
    const newNights = diffDays(newIn, newOut);
    if (newNights < 1) { s.newCheckIn = s.newCheckOut = undefined; return ask(w, "changes", "Check-out has to be after check-in. What dates would you like instead?"); }
    // check availability for the new dates (the tool also excludes nothing here: modify re-checks authoritatively)
    const room = s.newRoomType ?? v.roomTypeName;
    const av = await runTool("check_availability", ctx, { checkIn: newIn, checkOut: newOut, guests: s.newGuests ?? v.guests });
    if (av.ok) {
      const d = av.data as { verified: boolean; rooms?: { roomType: string; roomsAvailable: number; totalForStay: number }[] };
      const target = d.rooms?.find((r) => r.roomType === room);
      const sameStayOverlap = !s.newRoomType && room === v.roomTypeName && newIn < v.checkOut && newOut > v.checkIn; // our own booking holds a unit
      if (d.verified && target && target.roomsAvailable < 1 && !sameStayOverlap) {
        s.newCheckIn = s.newCheckOut = undefined;
        return ask(w, "changes", `I'm sorry, ${room} isn't available for ${speakDate(newIn)} to ${speakDate(newOut)}, so I haven't changed anything. Would you like different dates?`);
      }
      const newTotal = target?.totalForStay ?? v.nightlyRate * newNights;
      const diff = Math.round((newTotal - v.totalAmount) * 100) / 100;
      w.confirming = true;
      w.asked = "confirm";
      w.stuck = 0;
      state.wf = w;
      const diffText = diff === 0 ? "The price stays the same." : `The total would change by ${money(Math.abs(diff))} ${diff > 0 ? "more" : "less"}, which our team would need to approve before anything is charged or refunded.`;
      return reply(`To confirm, I'd change it to ${room}, ${speakDate(newIn)} to ${speakDate(newOut)}, ${newNights} ${newNights === 1 ? "night" : "nights"}. ${diffText} Shall I make the change?`);
    }
    return fallback("The booking system could not be reached to check the new dates.", w);
  }

  async function applyManage(w: Wf): Promise<AgentTurnResult> {
    const s = w.slots;
    const v = w.view!;
    if (w.kind === "cancel") {
      const r = await runTool("cancel_reservation", ctx, { confirmationCode: s.code, guestLastName: s.lastName });
      const d = r.ok ? (r.data as { done?: boolean; verified?: boolean }) : null;
      if (d?.done && d.verified) return done(`Your reservation ${speakCode(v.confirmationCode)} is cancelled. If you were charged anything, I can send a refund request to our team for review; I can't promise a refund myself.`);
      return fallback("The booking system did not confirm the cancellation.", w);
    }
    const r = await runTool("modify_reservation", ctx, { confirmationCode: s.code, guestLastName: s.lastName, newCheckIn: s.newCheckIn, newCheckOut: s.newCheckOut, newRoomType: s.newRoomType, newGuests: s.newGuests });
    if (!r.ok) return fallback(`The booking system did not confirm the change (${r.error.message}).`, w);
    const d = r.data as { done: boolean; verified?: boolean; reason?: string; message?: string; checkIn?: string; checkOut?: string; roomType?: string; totalAmount?: number; priceDifference?: number };
    if (d.done && d.verified) {
      let tail = "";
      if (d.priceDifference) {
        await runTool("request_payment_approval", ctx, {
          kind: "adjustment",
          amount: Math.abs(d.priceDifference),
          description: `${d.priceDifference > 0 ? "Additional charge" : "Refund"} of ${money(Math.abs(d.priceDifference))} after reservation ${v.confirmationCode} was changed`,
          reservationCode: v.confirmationCode,
          customerName: v.guestName,
        });
        tail = ` The price changed by ${money(Math.abs(d.priceDifference))}. I've sent that to our team for approval; nothing has been charged or refunded yet.`;
      }
      return done(`Done. Your reservation is now ${d.roomType}, ${speakDate(d.checkIn!)} to ${speakDate(d.checkOut!)}.${tail}`);
    }
    if (d.reason === "unavailable") {
      s.newCheckIn = s.newCheckOut = undefined;
      w.confirming = false;
      return ask(w, "changes", "I'm sorry, that isn't available, so your reservation is unchanged. Would you like different dates?");
    }
    return fallback("The booking system did not confirm the change.", w);
  }

  // ======================= PAYMENT (human approval) ============================================================
  async function paymentStep(w: Wf, utt: string, starting: boolean, dry: boolean): Promise<AgentTurnResult> {
    const s = w.slots;
    if (!dry && utt && !starting) {
      s.code ??= extractCode(utt);
      if (w.asked === "name") s.name = extractName(utt, true) ?? s.name;
      else if (!s.name && /\b(my name is|this is|i'?m|i am)\b/i.test(utt)) s.name = extractName(utt, true) ?? s.name;
      if (w.asked === "code" && NO.test(utt) && !s.code) w.asked = "code_skipped";
      const amt = utt.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
      if (amt) s.amount = Number(amt[1]);
    }
    if (!s.code && w.asked !== "code" && w.asked !== "code_skipped" && w.asked !== "name") {
      return ask(w, "code", `${s.payKind === "refund" ? "I can send a refund request to our team." : "I can send that to our team for approval."} I can't take card details or process any payment myself. Do you have a reservation confirmation code it relates to?`);
    }
    if (!s.name && w.asked !== "name") return ask(w, "name", "May I have your name for the request?");
    const r = await runTool("request_payment_approval", ctx, {
      kind: s.payKind ?? "charge",
      amount: s.amount,
      description: (s.purpose ?? "Payment request from a caller").replace(/\s+/g, " ").slice(0, 400),
      reservationCode: s.code,
      customerName: s.name,
    });
    if (!r.ok) return fallback(`A payment approval request could not be created (${r.error.message}).`, w);
    return done(
      `I've sent your ${s.payKind === "refund" ? "refund" : "payment"} request to our team for approval. I can't confirm anything has been ${s.payKind === "refund" ? "refunded" : "charged"} yet: a team member has to approve it first, and they'll follow up with a secure way to complete it.`,
    );
  }

  // ======================= EARLY CHECK-IN / LATE CHECK-OUT ====================================================
  async function stayRequestStep(w: Wf, utt: string, _starting: boolean, dry: boolean): Promise<AgentTurnResult> {
    const s = w.slots;
    if (!dry && utt) {
      if (w.asked === "name") s.name = extractName(utt, true) ?? s.name;
      s.code ??= extractCode(utt);
    }
    if (!s.name) return ask(w, "name", "I can pass that request to our front desk. They'll confirm if it's possible, as I can't guarantee early check-in or late check-out. May I have your name?");
    const policy = bestAnswer("early check-in late check-out", i.knowledge, [])?.answer;
    await runTool("create_service_request", ctx, {
      category: "front_desk",
      description: `${/late/i.test(s.detail ?? "") ? "Late check-out" : "Early check-in"} request: ${(s.detail ?? "").slice(0, 300)}${s.code ? ` (reservation ${s.code})` : ""}`,
      customerName: s.name,
      urgency: "normal",
    });
    return done(`I've passed your request to our front desk, and they'll confirm whether it's possible. It isn't guaranteed yet.${policy ? ` For reference: ${policy}` : ""}`);
  }
}
