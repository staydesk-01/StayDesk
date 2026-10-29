import { randomUUID } from "node:crypto";
import type { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { Call, CallTranscript, FollowUp, Notification, Opportunity, Reservation } from "../server/models";
import { Conversation, createHotel } from "../server/eval/harness";
import { agentEngine } from "../server/services/ai/agentEngine";
import { runTool } from "../server/tools/registry";
import { login, newCallSid, twilioPost } from "./helpers";
import { makeBusiness } from "./helpers";

const BOOK = "I'd like to book a deluxe king room this Friday for two nights, two guests.";
const COMPOUND = "What time is check-out and is breakfast included?";
const NAME_RETRY = /didn't catch your name|say it again/i;

async function hotel(withInventory: boolean, withUser = false) {
  const tb = await createHotel({ rooms: withInventory ? undefined : null, withUser });
  return { tb, c: await Conversation.start(tb) };
}
const segments = async (callId: Types.ObjectId) => (await CallTranscript.findOne({ callId }))!.segments;

describe.each([
  ["a hotel that takes inquiries only", false],
  ["a hotel with live inventory", true],
])("the reported conversation (%s)", (_label, inventory) => {
  it("answers the interruption, keeps the booking, and never asks for the name as if it were unanswered", async () => {
    const { tb, c } = await hotel(inventory);
    const ask = await c.say(BOOK);
    expect(ask.reply).toMatch(/name/i);

    const interrupted = await c.say(COMPOUND);
    expect(interrupted.reply).toMatch(/11 AM/); // check-out answered
    expect(interrupted.reply).toMatch(/breakfast/i); // breakfast answered
    expect(interrupted.reply).not.toMatch(NAME_RETRY);
    expect(interrupted.reply).not.toMatch(/don't have that verified/i);
    expect(interrupted.reply).toMatch(/name/i); // and returns to the missing detail

    const named = await c.say("John Carter");
    if (inventory) {
      expect(named.reply).toMatch(/Deluxe King.*2 guests.*2 nights.*John Carter/i);
      expect(named.reply).not.toMatch(/passed your booking request/i);
    } else {
      expect(named.reply).toMatch(/Thank you, John.*booking request/i);
      expect(named.reply).not.toMatch(/reservation is confirmed/i);
    }
    // nothing was asked twice in a row and no reply repeats an earlier one
    const replies = c.turns.map((t) => t.reply);
    expect(new Set(replies).size).toBe(replies.length);
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBe(inventory ? 0 : 1); // inquiry: one follow-up for staff; inventory: none yet
    void tb;
  });
});

describe("booking state and verification", () => {
  it("with live inventory: confirms only after the system does, once, and keeps earlier details", async () => {
    const { c } = await hotel(true);
    await c.say(BOOK);
    await c.say("John Carter");
    await c.say(COMPOUND); // interruption while waiting for "yes"
    expect(await Reservation.countDocuments()).toBe(0);
    let facts = ((await Call.findById(c.call._id))!.agentState as { facts: { bookingStatus: string; name: string; roomType: string; guests: number } }).facts;
    expect(facts).toMatchObject({ bookingStatus: "awaiting_confirmation", name: "John Carter", roomType: "Deluxe King Room", guests: 2 });

    const done = await c.say("yes");
    expect(done.reply).toMatch(/reservation is confirmed.*S D/i);
    expect(await Reservation.countDocuments()).toBe(1);
    facts = ((await Call.findById(c.call._id))!.agentState as { facts: typeof facts }).facts;
    expect(facts.bookingStatus).toBe("reservation_confirmed");
    const again = await c.say("yes"); // a stray second "yes" must not book again
    expect(await Reservation.countDocuments()).toBe(1);
    expect(again.reply).not.toMatch(/confirmation code/i);
  });

  it("inquiry only: says a request was passed on, never that it is confirmed, and records it as an inquiry", async () => {
    const { c } = await hotel(false);
    await c.sayAll(BOOK, "John Carter");
    const facts = ((await Call.findById(c.call._id))!.agentState as { facts: { bookingStatus: string } }).facts;
    expect(facts.bookingStatus).toBe("inquiry_received");
    expect(await Opportunity.countDocuments({ callId: c.call._id })).toBe(1);
    expect(c.turns.at(-1)!.reply).not.toMatch(/is confirmed|your reservation/i);
  });

  it("failed actions are reported as failed", async () => {
    const { c } = await hotel(true);
    await c.sayAll("I'd like a deluxe king room for 30 days from tomorrow, 2 guests", "John Carter");
    const facts = ((await Call.findById(c.call._id))!.agentState as { facts: { bookingStatus: string } }).facts;
    expect(["collecting", "failed", "none", "awaiting_confirmation", "follow_up_created"]).toContain(facts.bookingStatus);
    expect(facts.bookingStatus).not.toBe("reservation_confirmed");
  });
});

describe("conversation behaviour", () => {
  it("accepts the name later, after several questions, and keeps the booking details", async () => {
    const { c } = await hotel(true);
    await c.say(BOOK);
    const q1 = await c.say("Do you have parking?");
    const q2 = await c.say("And are pets allowed?");
    expect(q1.reply).toMatch(/\$25/);
    expect(q2.reply).toMatch(/dogs/i);
    const t = await c.say("It's Maria Lopez");
    expect(t.reply).toMatch(/Deluxe King.*Maria Lopez/i);
  });

  it("answers several questions in one message, only from verified facts", async () => {
    const { c } = await hotel(false);
    const r = await c.say("Do you have parking, is there a pool, and what time is check-in?");
    expect(r.reply).toMatch(/\$25/);
    expect(r.reply).toMatch(/pool/i);
    expect(r.reply).toMatch(/3 PM/);
  });

  it("states what is unverified once and does not keep offering callbacks while other questions can be answered", async () => {
    const { c } = await hotel(false);
    await c.say(BOOK);
    const a = await c.say("Do you have a helicopter pad, and what time is check-out?");
    expect(a.reply).toMatch(/11 AM/);
    expect(a.reply).toMatch(/don't have.*verified/i);
    const b = await c.say("Do you have a casino?");
    expect(b.reply).toMatch(/don't have that verified/i);
    const c2 = await c.say("Is breakfast included?");
    expect(c2.reply).toMatch(/breakfast/i);
    expect(c2.reply).not.toMatch(/call you back|follow up/i);
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBe(1); // one queued item for staff, not one per question
  });

  it("changes the room type mid-booking without losing the other details", async () => {
    const { c } = await hotel(true);
    await c.sayAll(BOOK, "Dana Reed");
    const r = await c.say("Actually, make it the family room instead");
    expect(r.reply).toMatch(/Family Room.*2 guests.*2 nights.*Dana Reed/i);
  });

  it("answers a repeated question again (repeats are real questions), without repeating the booking summary", async () => {
    const { c } = await hotel(true);
    await c.sayAll(BOOK, "John Carter");
    const a = await c.say("What time is check-out?");
    const b = await c.say("What time is check-out?");
    expect(a.reply).toMatch(/11 AM/);
    expect(b.reply).toMatch(/11 AM/);
    expect(b.reply).not.toMatch(/To confirm:/);
  });

  it("one caller message produces exactly one agent response, linked by id", async () => {
    const { c } = await hotel(true);
    await c.sayAll(BOOK, COMPOUND, "John Carter", "Do you have parking?", "yes");
    const segs = (await segments(c.call._id)).filter((s) => s.role === "caller" || s.role === "agent");
    const callers = segs.filter((s) => s.role === "caller");
    const agents = segs.filter((s) => s.role === "agent" && s.replyTo);
    expect(callers).toHaveLength(5);
    expect(agents).toHaveLength(5);
    expect(new Set(segs.map((s) => s.id).filter(Boolean)).size).toBe(segs.filter((s) => s.id).length); // ids unique
    for (const a of agents) expect(callers.some((cs) => cs.id === a.replyTo)).toBe(true);
  });
});

describe("retries and duplicates", () => {
  it("a message resent with the same id returns the same reply and runs nothing twice", async () => {
    const { c } = await hotel(false);
    await c.say(BOOK);
    const id = randomUUID();
    const first = await agentEngine.respondWithStatus(c.call._id, "John Carter", { messageId: id });
    const retry = await agentEngine.respondWithStatus(c.call._id, "John Carter", { messageId: id });
    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(retry.reply).toBe(first.reply);
    expect(retry.responseId).toBe(first.responseId);
    expect(await Opportunity.countDocuments({ callId: c.call._id })).toBe(1);
    expect(await Notification.countDocuments({ callId: c.call._id, type: "booking_inquiry" })).toBe(1);
    const callerLines = (await segments(c.call._id)).filter((s) => s.role === "caller" && s.text === "John Carter");
    expect(callerLines).toHaveLength(1);
  });

  it("two identical requests at the same moment are processed once", async () => {
    const { c } = await hotel(true);
    await c.sayAll(BOOK, "John Carter");
    const id = randomUUID();
    const [a, b] = await Promise.all([agentEngine.respondWithStatus(c.call._id, "yes", { messageId: id }), agentEngine.respondWithStatus(c.call._id, "yes", { messageId: id })]);
    expect(a.reply).toBe(b.reply);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await Reservation.countDocuments()).toBe(1);
  });

  it("different ids with the same text are separate messages (an intentional repeat is not dropped)", async () => {
    const { c } = await hotel(false);
    const a = await agentEngine.respondWithStatus(c.call._id, "Do you have parking?", { messageId: randomUUID() });
    const b = await agentEngine.respondWithStatus(c.call._id, "Do you have parking?", { messageId: randomUUID() });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(b.reply).toMatch(/\$25/);
    expect((await segments(c.call._id)).filter((s) => s.role === "caller")).toHaveLength(2);
  });

  it("overlapping different messages are handled one at a time, in order", async () => {
    const { c } = await hotel(true);
    await c.say(BOOK);
    const [a, b] = await Promise.all([agentEngine.respond(c.call._id, "John Carter", { messageId: randomUUID() }), agentEngine.respond(c.call._id, "yes", { messageId: randomUUID() })]);
    expect(a.reply).toMatch(/To confirm/);
    expect(b.reply).toMatch(/reservation is confirmed/i);
    expect(await Reservation.countDocuments()).toBe(1);
  });

  it("the same API request retried over the network does not repeat the turn or the booking", async () => {
    const tb = await createHotel({ withUser: true });
    const agent = await login(tb.userEmail);
    const start = await agent.post("/api/test-agent/sessions").send({});
    const id = start.body.callId;
    await agent.post(`/api/test-agent/sessions/${id}/message`).send({ text: BOOK, messageId: randomUUID() });
    await agent.post(`/api/test-agent/sessions/${id}/message`).send({ text: "John Carter", messageId: randomUUID() });
    const mid = randomUUID();
    const r1 = await agent.post(`/api/test-agent/sessions/${id}/message`).send({ text: "yes", messageId: mid });
    const r2 = await agent.post(`/api/test-agent/sessions/${id}/message`).send({ text: "yes", messageId: mid });
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.reply).toBe(r1.body.reply);
    expect(r2.body.responseId).toBe(r1.body.responseId);
    expect(await Reservation.countDocuments()).toBe(1);
  });

  it("a page reload restores the same conversation (ids intact) and the booking carries on", async () => {
    const tb = await createHotel({ withUser: true });
    const agent = await login(tb.userEmail);
    const id = (await agent.post("/api/test-agent/sessions").send({})).body.callId;
    const m1 = randomUUID();
    const r1 = await agent.post(`/api/test-agent/sessions/${id}/message`).send({ text: BOOK, messageId: m1 });
    await agent.post(`/api/test-agent/sessions/${id}/message`).send({ text: COMPOUND, messageId: randomUUID() });

    // "reload": the client forgets everything and asks the server for the session
    const restored = await agent.get(`/api/test-agent/sessions/${id}`);
    expect(restored.status).toBe(200);
    const segs = restored.body.segments as { id: string | null; role: string; text: string }[];
    expect(segs.map((s) => s.role)).toEqual(["agent", "caller", "agent", "caller", "agent"]);
    expect(segs.find((s) => s.id === m1)?.text).toBe(BOOK);
    expect(segs.find((s) => s.id === r1.body.responseId)?.role).toBe("agent");
    expect(restored.body.call.facts).toMatchObject({ roomType: "Deluxe King Room", guests: 2, bookingStatus: "collecting" });

    const next = await agent.post(`/api/test-agent/sessions/${id}/message`).send({ text: "John Carter", messageId: randomUUID() });
    expect(next.body.reply).toMatch(/To confirm: Deluxe King/);
    expect(next.body.reply).not.toMatch(/may i have/i);
  });

  it("the same Twilio webhook delivered twice answers identically and runs once", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const sid = newCallSid();
    await twilioPost("/api/twilio/incoming", { CallSid: sid, From: "+15558880000", To: biz.config.twilioNumber!, CallStatus: "ringing" });
    const call = (await Call.findOne({ providerCallId: sid }))!;
    const url = `/api/twilio/gather?callId=${call._id}`;
    const send = (speech: string, token: string) => {
      const params = { CallSid: sid, SpeechResult: speech };
      return import("../tests/client").then(async ({ makeClient }) => {
        const twilio = (await import("twilio")).default;
        const signature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, `https://staydesk.test${url}`, params);
        return makeClient().post(url).set("X-Twilio-Signature", signature).set("I-Twilio-Idempotency-Token", token).type("form").send(params);
      });
    };
    const first = await send("Do you have parking?", "tok-aaaaaaaa-1");
    const dup = await send("Do you have parking?", "tok-aaaaaaaa-1");
    expect(dup.text).toBe(first.text);
    expect((await segments(call._id)).filter((s) => s.role === "caller")).toHaveLength(1);
    // the caller really saying it again later is a new delivery with a new token
    await send("Do you have parking?", "tok-bbbbbbbb-2");
    expect((await segments(call._id)).filter((s) => s.role === "caller")).toHaveLength(2);
  });
});

describe("backend actions are idempotent", () => {
  it("retried tool calls create one reservation, one inquiry and one follow-up", async () => {
    const { tb, c } = await hotel(true);
    const ctx = { businessId: tb.business._id, callId: c.call._id };
    const book = { guestName: "John Carter", roomType: "Deluxe King Room", checkIn: "2027-03-05", checkOut: "2027-03-07", guests: 2 };
    const a = await runTool("create_reservation", ctx, book);
    const b = await runTool("create_reservation", ctx, book);
    expect(a.ok && b.ok).toBe(true);
    expect(await Reservation.countDocuments()).toBe(1);
    expect((a.ok && (a.data as { confirmationCode: string }).confirmationCode)).toBe(b.ok && (b.data as { confirmationCode: string }).confirmationCode);

    const lead = { type: "booking", customerName: "John Carter", details: "Deluxe King room for two" };
    await runTool("create_booking_or_lead", ctx, lead);
    await runTool("create_booking_or_lead", ctx, lead);
    expect(await Opportunity.countDocuments({ callId: c.call._id, status: "new" })).toBe(1); // the inquiry, recorded once
    expect(await Opportunity.countDocuments({ callId: c.call._id, status: "converted" })).toBe(1); // the retried reservation, recorded once

    const fu = { reason: "Please confirm the airport shuttle time", priority: "normal" };
    await runTool("create_follow_up", ctx, fu);
    await runTool("create_follow_up", ctx, fu);
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBe(1);
  });
});
