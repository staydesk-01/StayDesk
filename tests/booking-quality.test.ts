import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessKnowledge, Call, FollowUp, Opportunity, PaymentApproval, Reservation } from "../server/models";
import { Conversation, createHotel } from "../server/eval/harness";
import type { TestBusiness } from "../server/eval/harness";
import { agentEngine } from "../server/services/ai/agentEngine";
import { runTool } from "../server/tools/registry";
import { __setProvidersForTest, nativeBookingProviderForTest } from "./scenario-helpers";

afterEach(() => __setProvidersForTest(null));

const FALLBACK = /don't have that information verified/i;
const setBooking = (tb: TestBusiness, booking: object) => BusinessKnowledge.updateOne({ businessId: tb.business._id }, { $set: Object.fromEntries(Object.entries(booking).map(([k, v]) => [`booking.${k}`, v])) });
const BOOK = ["Book a Deluxe King room for tomorrow for two nights", "two guests", "Dana Reed"];

describe("conversation: unknowns, refusals and repeats", () => {
  it("answers what it knows, says what it does not, and never repeats the same fallback or offers a callback after a refusal", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const first = await c.say("Do you have a gym?");
    expect(first.reply).toMatch(FALLBACK);
    expect(first.reply).toMatch(/call you back/i); // offered once
    const declined = await c.say("no, I don't want a callback");
    expect(declined.reply).toMatch(/won't arrange a callback/i);

    const mixed = await c.say("Do you have a spa and is breakfast included?");
    expect(mixed.reply).toMatch(/breakfast/i); // the known part is answered
    expect(mixed.reply).toMatch(/don't have the rest verified/i);
    expect(mixed.reply).not.toMatch(/asked our team|call you back/i); // and no callback is promised after a refusal

    const again1 = await c.say("Do you have a sauna?");
    const again2 = await c.say("Do you have a sauna?");
    expect(again1.reply).not.toMatch(/call you back/i);
    expect(again2.reply).not.toBe(again1.reply); // not the same sentence twice in a row
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBe(0); // nothing was queued against their wishes
  });

  it("a callback is only claimed when the follow-up record really exists", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await Call.updateOne({ _id: c.call._id }, { $set: { endedAt: new Date() } }); // tools now refuse: the follow-up cannot be created
    const r = await c.say("Do you have a spa and is breakfast included?");
    expect(r.reply).toMatch(/breakfast/i);
    expect(r.reply).not.toMatch(/asked our team|follow up on it/i);
    expect(await FollowUp.countDocuments({ businessId: tb.business._id })).toBe(0);
  });

  it("when a callback IS created, the record exists and it is mentioned once", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const a = await c.say("Do you have a spa and is breakfast included?");
    expect(a.reply).toMatch(/asked our team to follow up/i);
    await c.say("Do you have a casino and is there parking?");
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBe(1);
  });

  it("a name, an email or 'ok' with nothing pending is not a question: it never gets the 'not verified' fallback", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    for (const line of ["Maria Gomez", "maria@example.com", "ok"]) {
      const r = await c.say(line);
      expect(r.reply, line).not.toMatch(FALLBACK);
    }
  });

  it("topic changes mid-booking keep the booking and answer the new question; repeats are answered again", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.sayAll(BOOK[0], BOOK[1]);
    const q1 = await c.say("do you allow pets?");
    const q2 = await c.say("do you allow pets?");
    expect(q1.reply).toMatch(/dogs/i);
    expect(q2.reply).toMatch(/dogs/i);
    const name = await c.say("Dana Reed");
    expect(name.reply).toMatch(/To confirm: Deluxe King Room for 2 guests/);
  });

  it("an interrupted conversation (caller drops mid-booking) books nothing and queues a callback for staff", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.sayAll(BOOK[0], BOOK[1]);
    const { finalizeCall } = await import("../server/services/calls/callService");
    await finalizeCall(c.call._id);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
    expect(await FollowUp.countDocuments({ callId: c.call._id, reason: /NOTHING was confirmed/ })).toBe(1);
  });
});

describe("knowledge belongs to the right business", () => {
  it("each hotel answers from its own records only", async () => {
    const a = await createHotel({ name: "Hotel Alpha" });
    const b = await createHotel({ name: "Hotel Beta" });
    await BusinessKnowledge.updateOne({ businessId: a.business._id }, { $set: { faqs: [{ question: "Do you have parking?", answer: "Alpha parking is free." }] } });
    await BusinessKnowledge.updateOne({ businessId: b.business._id }, { $set: { faqs: [{ question: "Do you have parking?", answer: "Beta parking costs $40." }] } });
    const ca = await Conversation.start(a);
    const cb = await Conversation.start(b);
    expect((await ca.say("Do you have parking?")).reply).toMatch(/Alpha parking is free/);
    expect((await cb.say("Do you have parking?")).reply).toMatch(/Beta parking costs \$40/);
    expect((await ca.say("Do you have parking?")).reply).not.toMatch(/Beta|\$40/);
  });

  it("a business with no knowledge says so honestly instead of inventing", async () => {
    const tb = await createHotel();
    await BusinessKnowledge.updateOne({ businessId: tb.business._id }, { $set: { faqs: [], services: [], policies: "", pricingInfo: "" } });
    const c = await Conversation.start(tb);
    const r = await c.say("What time is check-in?");
    expect(r.reply).toMatch(/don't have that/i);
    expect(r.reply).not.toMatch(/\d\s?(AM|PM)/i);
  });
});

describe("verified reservation details", () => {
  it("quotes rates, taxes and cancellation terms only from verified data", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.sayAll(BOOK[0], BOOK[1]);
    const noTax = await c.say("what's the total with tax?");
    expect(noTax.reply).toMatch(/\$378 for 2 nights before taxes/);
    expect(noTax.reply).toMatch(/don't have taxes and fees verified/i);
    const confirm = await c.say("Dana Reed");
    expect(confirm.reply).toMatch(/\$189 per night, \$378 before taxes/);
    expect(confirm.reply).toMatch(/Cancellation: Reservations can be cancelled free of charge up to 48 hours/);
    expect(confirm.reply).toMatch(/don't have taxes and fees verified/i);

    await setBooking(tb, { taxRatePercent: 10 });
    const c2 = await Conversation.start(tb);
    await c2.sayAll(BOOK[0], BOOK[1]);
    const taxed = await c2.say("how much is it with tax?");
    expect(taxed.reply).toMatch(/Taxes at 10% add \$37\.80, for \$415\.80 in total/);
  });

  it("says the cancellation terms are unverified when the hotel has not provided them", async () => {
    const tb = await createHotel();
    await BusinessKnowledge.updateOne({ businessId: tb.business._id }, { $set: { faqs: [{ question: "Do you have parking?", answer: "Yes." }], policies: "" } });
    const c = await Conversation.start(tb);
    const confirm = await c.sayAll(...BOOK);
    expect(confirm.reply).toMatch(/don't have the cancellation terms verified/i);
  });

  it("collects contact details: caller ID by default (read back), a different number or an email when given", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb, { callerNumber: "+18055550101" });
    const confirm = await c.sayAll(...BOOK);
    expect(confirm.reply).toMatch(/8 0 5, 5 5 5, 0 1 0 1 as the contact number/);
    await c.say("actually my number is 310 555 0199 and my email is dana@example.com");
    await c.say("yes");
    const res = (await Reservation.findOne({ businessId: tb.business._id }))!;
    expect(res.guestPhone).toBe("+13105550199");
    expect(res.guestEmail).toBe("dana@example.com");
    expect(res.confirmationCode).toMatch(/^SD-/);
  });

  it("asks for a number when the caller ID is unknown", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb, { callerNumber: "" });
    const ask = await c.sayAll(...BOOK);
    expect(ask.reply).toMatch(/best phone number/i);
    const confirm = await c.say("805 555 0142");
    expect(confirm.reply).toMatch(/8 0 5, 5 5 5, 0 1 4 2/);
  });

  it("only calls it confirmed when the system returns a verified code (and not for a reservation the system refused)", async () => {
    const tb = await createHotel();
    const native = nativeBookingProviderForTest();
    __setProvidersForTest([{ ...native, createReservation: async () => { throw new Error("PMS timeout"); } }]);
    const c = await Conversation.start(tb);
    await c.sayAll(...BOOK);
    const r = await c.say("yes");
    expect(r.reply).not.toMatch(/is confirmed/i);
    expect(r.reply).toMatch(/wasn't able to complete/i);
    expect(await Reservation.countDocuments()).toBe(0);
  });

  it("with no reservation integration it says plainly that nothing is confirmed, and still records the request", async () => {
    const tb = await createHotel({ rooms: null });
    const c = await Conversation.start(tb);
    await c.sayAll("I'd like to book a deluxe king room this Friday for two nights, two guests", "Dana Reed");
    const last = c.turns.at(-1)!.reply;
    expect(last).toMatch(/I can't confirm it myself, so it is not confirmed yet/i);
    expect(last).not.toMatch(/is confirmed|confirmation code/i);
    expect(await Reservation.countDocuments()).toBe(0);
    expect(await Opportunity.countDocuments({ callId: c.call._id })).toBe(1);
  });

  it("the lead path does not promise a callback the caller declined", async () => {
    const tb = await createHotel({ rooms: null });
    const c = await Conversation.start(tb);
    await c.say("I'd like to book a deluxe king room this Friday for two nights, two guests");
    await c.say("no I don't want a callback");
    await c.say("Dana Reed");
    expect(c.turns.at(-1)!.reply).not.toMatch(/call you back/i);
    expect(c.turns.at(-1)!.reply).toMatch(/recorded your booking request/i);
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBe(0);
  });
});

describe("deposits and secure payment", () => {
  it("after_booking: the reservation is real, the deposit goes to staff as a payment request, and no card details are asked or taken", async () => {
    const tb = await createHotel();
    await setBooking(tb, { depositPolicy: "after_booking", depositPercent: 20 });
    const c = await Conversation.start(tb);
    const confirm = await c.sayAll(...BOOK);
    expect(confirm.reply).toMatch(/deposit of \$75\.60 is required after booking/i);
    expect(confirm.reply).toMatch(/can't take card details/i);
    const done = await c.say("yes");
    expect(done.reply).toMatch(/reservation is confirmed/i);
    expect(done.reply).toMatch(/secure payment request to our team/i);
    expect(done.reply).toMatch(/No payment has been taken/i);
    expect(done.reply).not.toMatch(/card number|expiry|cvv/i);
    expect(await Reservation.countDocuments()).toBe(1);
    const pay = await PaymentApproval.find({ callId: c.call._id });
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ kind: "charge", status: "pending", amount: 75.6 });
  });

  it("to_confirm: nothing is reserved or called confirmed until staff receive the deposit", async () => {
    const tb = await createHotel();
    await setBooking(tb, { depositPolicy: "to_confirm", depositPercent: 50 });
    const c = await Conversation.start(tb);
    const confirm = await c.sayAll(...BOOK);
    expect(confirm.reply).toMatch(/before the reservation can be confirmed/i);
    expect(confirm.reply).toMatch(/Shall I send that request/);
    const done = await c.say("yes");
    expect(done.reply).toMatch(/can't confirm this reservation until the deposit is received/i);
    expect(done.reply).not.toMatch(/reservation is confirmed|confirmation code/i);
    expect(await Reservation.countDocuments()).toBe(0);
    expect(await Opportunity.countDocuments({ callId: c.call._id })).toBe(1);
    expect((await PaymentApproval.findOne({ callId: c.call._id }))!).toMatchObject({ amount: 189, status: "pending" });
  });

  it("a retried 'yes' (same message id) never creates a second reservation or a second payment request", async () => {
    const tb = await createHotel();
    await setBooking(tb, { depositPolicy: "after_booking", depositPercent: 20 });
    const c = await Conversation.start(tb);
    await c.sayAll(...BOOK);
    const id = randomUUID();
    const [a, b] = await Promise.all([agentEngine.respond(c.call._id, "yes", { messageId: id }), agentEngine.respond(c.call._id, "yes", { messageId: id })]);
    expect(b.reply).toBe(a.reply);
    expect(await Reservation.countDocuments()).toBe(1);
    expect(await PaymentApproval.countDocuments({ callId: c.call._id })).toBe(1);
    // and the same payment request issued twice through the tool (a retry that bypasses the turn guard) is also one record
    const input = { kind: "charge", amount: 75.6, description: "Deposit for reservation retry test" };
    await runTool("request_payment_approval", { businessId: tb.business._id, callId: c.call._id }, input);
    await runTool("request_payment_approval", { businessId: tb.business._id, callId: c.call._id }, input);
    expect(await PaymentApproval.countDocuments({ callId: c.call._id, description: input.description })).toBe(1);
  });
});
