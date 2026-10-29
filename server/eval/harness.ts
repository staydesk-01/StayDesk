import { randomUUID } from "node:crypto";
import { Business, BusinessKnowledge, PhoneConfiguration, RoomType } from "../models";
import type { BusinessDoc, CallDoc } from "../models";
import { agentEngine } from "../services/ai/agentEngine";
import { createBusinessWithOwner } from "../services/business/businessService";
import { createCallSession, finalizeCall } from "../services/calls/callService";

const OPEN = { closed: false, open: "00:00", close: "24:00" };
const week = { mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN, sun: OPEN };

export interface RoomSpec {
  name: string;
  nightlyRate: number;
  capacity: number;
  totalUnits: number;
  description?: string;
}

export const DEFAULT_ROOMS: RoomSpec[] = [
  { name: "Deluxe King Room", nightlyRate: 189, capacity: 2, totalUnits: 5, description: "King bed, courtyard view" },
  { name: "Family Room", nightlyRate: 229, capacity: 4, totalUnits: 2, description: "Two queen beds" },
  { name: "Ocean View Suite", nightlyRate: 289, capacity: 3, totalUnits: 1, description: "Private balcony" },
];

const HOTEL_FAQS = [
  { question: "What time is check-in and check-out?", answer: "Check-in starts at 3 PM and check-out is at 11 AM." },
  { question: "Is breakfast included?", answer: "Yes, a complimentary continental breakfast is served from 7 to 10 AM in the lobby cafe." },
  { question: "Do you have parking?", answer: "We offer secure on-site parking for $25 per night." },
  { question: "Are pets allowed?", answer: "Dogs up to 40 pounds are welcome in Deluxe King rooms for a one-time $40 pet fee." },
  { question: "Is there a pool?", answer: "Yes, our rooftop pool is open daily from 8 AM to 9 PM." },
  { question: "What is the cancellation policy?", answer: "Reservations can be cancelled free of charge up to 48 hours before check-in." },
  { question: "Can I get early check-in or late check-out?", answer: "Early check-in and late check-out depend on availability and must be confirmed by the front desk." },
];

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface TestBusiness {
  business: BusinessDoc;
  /** only set when the scenario needs to sign in to the dashboard API */
  userEmail: string;
  type: "hotel" | "medical";
}

/** A hotel with verified knowledge and (optionally) bookable inventory, fully isolated from every other business. */
async function baseBusiness(name: string, type: "hotel" | "medical", withUser: boolean) {
  const id = unique();
  if (withUser) {
    const { business, user } = await createBusinessWithOwner({ businessName: name, name: "Owner", email: `eval-${id}@example.test`, password: "Password123!", businessType: type });
    return { business, userEmail: user.email };
  }
  // No user (and no password hashing): the vast majority of scenarios only need the business itself.
  const business = await Business.create({ name, type, ownerEmail: `eval-${id}@example.test` });
  await Promise.all([BusinessKnowledge.create({ businessId: business._id }), PhoneConfiguration.create({ businessId: business._id })]);
  return { business, userEmail: "" };
}

export async function createHotel(opts: { rooms?: RoomSpec[] | null; name?: string; withUser?: boolean } = {}): Promise<TestBusiness> {
  const { business, userEmail } = await baseBusiness(opts.name ?? `Eval Hotel ${unique()}`, "hotel", !!opts.withUser);
  business.timezone = "America/New_York";
  business.address = "1 Harbor Street";
  business.escalationPhone = "+15550001111";
  await business.save();
  await BusinessKnowledge.updateOne(
    { businessId: business._id },
    {
      $set: {
        description: "A boutique hotel near the beach.",
        hours: week,
        services: [{ name: "Airport Shuttle", description: "Scheduled shuttle", price: "$25 per person" }],
        faqs: HOTEL_FAQS,
        pricingInfo: "Rooms start at $189 per night.",
        policies: "Check-in 3 PM, check-out 11 AM. Free cancellation up to 48 hours before arrival.",
      },
    },
  );
  await PhoneConfiguration.updateOne({ businessId: business._id }, { $set: { twilioNumber: `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`, humanNumber: "+15550001111" } });
  if (opts.rooms !== null) await RoomType.insertMany((opts.rooms ?? DEFAULT_ROOMS).map((r) => ({ ...r, businessId: business._id })));
  return { business, userEmail, type: "hotel" };
}

/** A healthcare office: administrative help only; clinical advice and patient data are off limits. */
export async function createClinic(): Promise<TestBusiness> {
  const { business, userEmail } = await baseBusiness(`Eval Dental ${unique()}`, "medical", false);
  business.timezone = "America/New_York";
  business.escalationPhone = "+15550002222";
  await business.save();
  await BusinessKnowledge.updateOne(
    { businessId: business._id },
    {
      $set: {
        description: "A family dental office.",
        hours: week,
        services: [{ name: "Cleaning", description: "Routine cleaning", price: "" }],
        faqs: [{ question: "Where are you located?", answer: "We are at 5 Main Street, Suite 2." }, { question: "Do you accept new patients?", answer: "Yes, we are accepting new patients." }],
        policies: "Please arrive 10 minutes early. 24 hours notice is requested to reschedule.",
      },
    },
  );
  await PhoneConfiguration.updateOne({ businessId: business._id }, { $set: { twilioNumber: `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`, humanNumber: "+15550002222" } });
  return { business, userEmail, type: "medical" };
}

export interface Turn {
  caller: string;
  reply: string;
  intent: string;
  latencyMs: number;
  ended: boolean;
  transfer: boolean;
}

/** One simulated phone call driven through the real agent engine, tools and database. */
export class Conversation {
  turns: Turn[] = [];
  greeting = "";
  constructor(
    public call: CallDoc,
    public tb: TestBusiness,
  ) {}

  static async start(tb: TestBusiness, opts: { callerNumber?: string; transferAnswers?: boolean } = {}): Promise<Conversation> {
    const call = await createCallSession({
      businessId: tb.business._id,
      provider: "simulator",
      providerCallId: `sim_${randomUUID()}`,
      callerNumber: opts.callerNumber ?? "+15551230000",
      businessNumber: "eval",
      routingReason: "no_answer",
      handledBy: "ai",
      status: "ai_answered",
    });
    call.answeredAt = new Date();
    call.agentState = { simulateTransferAnswers: !!opts.transferAnswers };
    await call.save();
    const convo = new Conversation(call, tb);
    convo.greeting = await agentEngine.greet(call);
    return convo;
  }

  async say(text: string): Promise<Turn> {
    const t0 = Date.now();
    const r = await agentEngine.respond(this.call._id, text);
    const turn: Turn = { caller: text, reply: r.reply, intent: r.intent, latencyMs: Date.now() - t0, ended: r.end, transfer: r.transfer };
    this.turns.push(turn);
    return turn;
  }

  /** Say several things in a row; returns the last reply. */
  async sayAll(...lines: string[]): Promise<Turn> {
    let last!: Turn;
    for (const l of lines) last = await this.say(l);
    return last;
  }

  /** Hang up (also what a dropped line looks like to the backend). */
  async hangUp() {
    return finalizeCall(this.call._id);
  }

  get replies() {
    return this.turns.map((t) => t.reply);
  }
}
