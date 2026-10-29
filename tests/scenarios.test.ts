import { afterEach, describe, expect, it } from "vitest";
import { CallTranscript, FollowUp, Notification, Opportunity, PaymentApproval, Reservation, ServiceRequest, Call } from "../server/models";
import { Conversation, createClinic, createHotel } from "../server/eval/harness";
import { addDays } from "../server/services/ai/dates";
import { __setProvidersForTest, getBookingProvider, nativeBookingProviderForTest } from "./scenario-helpers";
import { localDateKey } from "../server/services/calls/businessHours";
import { runTool } from "../server/tools/registry";
import { login } from "./helpers";

const today = () => localDateKey(new Date(), "America/New_York");
const spell = (code: string) => code.replace("-", "").split("").join(" ");
const codeFrom = (reply: string) => reply.match(/S D, ((?:[A-Z0-9] ?){6})/)?.[1].replace(/ /g, "");

afterEach(() => __setProvidersForTest(null));

async function bookDirect(tb: Awaited<ReturnType<typeof createHotel>>, opts: { room?: string; inDays: number; nights: number; guest?: string; phone?: string }) {
  const p = (await getBookingProvider(tb.business._id))!;
  const rooms = await p.listRoomTypes(tb.business._id);
  const room = rooms.find((r) => r.name.includes(opts.room ?? "Deluxe"))!;
  return p.createReservation(tb.business._id, {
    roomTypeId: room.roomTypeId, guestName: opts.guest ?? "Pat Lee", guestPhone: opts.phone ?? "+15559990000", guests: 2,
    checkIn: addDays(today(), opts.inDays), checkOut: addDays(today(), opts.inDays + opts.nights), source: "staff",
  });
}

describe("information", () => {
  it("answers check-in / check-out questions from verified knowledge and creates no records", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    expect(c.greeting).toMatch(/AI assistant/i); // discloses it is an AI
    const t = await c.say("What time is check-in and check-out?");
    expect(t.reply).toMatch(/3 PM/);
    expect(t.reply).toMatch(/11 AM/);
    expect(t.intent).toBe("general_question");
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
    expect(await Opportunity.countDocuments({ businessId: tb.business._id })).toBe(0);
  });

  it("handles several questions in one call, each answered from the knowledge base", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    expect((await c.say("Is breakfast included?")).reply).toMatch(/continental breakfast/i);
    expect((await c.say("Do you have parking?")).reply).toMatch(/\$25/);
    expect((await c.say("Are pets allowed?")).reply).toMatch(/40 pounds/);
    expect((await c.say("No that's all, bye")).ended).toBe(true);
    await c.hangUp();
    const call = await Call.findById(c.call._id);
    expect(call!.metrics!.turns).toBe(4);
    expect(call!.metrics!.toolFailures).toBe(0);
  });

  it("never invents an answer it doesn't have, and offers a human callback", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const t = await c.say("Do you have an electric car charger and what does the spa cost?");
    expect(t.reply).toMatch(/don't have that information verified/i);
    expect(t.reply).not.toMatch(/\$\d/);
    const t2 = await c.say("yes please");
    expect(t2.reply).toMatch(/name/i);
  });

  it("refuses unsupported requests honestly instead of improvising", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const t = await c.say("Can you book me a flight to Paris?");
    expect(t.reply).toMatch(/can't help with that/i);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
    expect(await Opportunity.countDocuments({ businessId: tb.business._id })).toBe(0);
  });
});

describe("autonomous reservation", () => {
  it("books end to end, verified, with a system-generated confirmation code", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.say("Hi, I'd like to book a Deluxe King room for tomorrow for two nights");
    const guests = await c.say("two guests");
    expect(guests.reply).toMatch(/name for the reservation/i);
    const confirm = await c.say("My name is Jordan Reed");
    expect(confirm.reply).toMatch(/To confirm: Deluxe King Room for 2 guests/);
    expect(confirm.reply).toMatch(/\$378 before taxes/);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0); // nothing booked before the caller says yes

    const booked = await c.say("Yes, please book it");
    expect(booked.reply).toMatch(/reservation is confirmed/i);
    expect(booked.reply).toMatch(/No payment has been taken/i);

    const res = (await Reservation.findOne({ businessId: tb.business._id }))!;
    expect(res).toMatchObject({ guestName: "Jordan Reed", roomTypeName: "Deluxe King Room", checkIn: addDays(today(), 1), checkOut: addDays(today(), 3), nights: 2, guests: 2, totalAmount: 378, status: "confirmed" });
    expect(res.confirmationCode).toMatch(/^SD-[A-HJKMNP-Z2-9]{6}$/);
    expect(codeFrom(booked.reply)).toBe(res.confirmationCode.slice(3)); // the spoken code is the one in the database

    await c.hangUp();
    const call = (await Call.findById(c.call._id))!;
    expect(call.outcome).toBe("reservation_confirmed");
    const opp = (await Opportunity.findOne({ callId: c.call._id }))!;
    expect(opp.status).toBe("converted");
    expect(opp.verifiedValue).toBeUndefined(); // booked != revenue verified
    expect((await Notification.find({ businessId: tb.business._id })).map((n) => n.title).join("|")).toMatch(/Reservation confirmed/);
    expect(call.actions.map((a) => a.tool)).toEqual(expect.arrayContaining(["check_availability", "create_reservation"]));
  });

  it("reports unavailable rooms truthfully and offers real alternatives", async () => {
    const tb = await createHotel();
    await bookDirect(tb, { room: "Ocean", inDays: 1, nights: 2 }); // the only suite
    const c = await Conversation.start(tb, { callerNumber: "+15557770000" });
    const t = await c.say("I want to book the Ocean View Suite tomorrow for two nights for two guests");
    expect(t.reply).toMatch(/isn't available/i);
    expect(t.reply).toMatch(/Deluxe King Room at \$189/);
    expect(await Reservation.countDocuments({ businessId: tb.business._id, roomTypeName: "Ocean View Suite" })).toBe(1); // still just the original
  });

  it("says there is no availability when everything is sold out", async () => {
    const tb = await createHotel({ rooms: [{ name: "Deluxe King Room", nightlyRate: 189, capacity: 2, totalUnits: 1 }] });
    await bookDirect(tb, { inDays: 1, nights: 3 });
    const c = await Conversation.start(tb, { callerNumber: "+15557770000" });
    const t = await c.say("Book a room for tomorrow for one night, just me");
    expect(t.reply).toMatch(/no rooms available/i);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(1);
  });

  it("never double-books the last room when two callers race for it", async () => {
    const tb = await createHotel({ rooms: [{ name: "Deluxe King Room", nightlyRate: 189, capacity: 2, totalUnits: 1 }] });
    const p = (await getBookingProvider(tb.business._id))!;
    const rt = (await p.listRoomTypes(tb.business._id))[0];
    const mk = (n: string) => p.createReservation(tb.business._id, { roomTypeId: rt.roomTypeId, guestName: n, guestPhone: "", guests: 1, checkIn: addDays(today(), 5), checkOut: addDays(today(), 7) });
    const results = await Promise.allSettled([mk("A"), mk("B"), mk("C")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await Reservation.countDocuments({ businessId: tb.business._id, status: "confirmed" })).toBe(1);
  });

  it("asks clarifying questions for vague or missing details instead of guessing", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const t1 = await c.say("I'd like a room sometime next week");
    expect(t1.reply).toMatch(/exact check-in and check-out dates/i);
    const t2 = await c.say("the 20th of next month");
    expect(t2.reply).toMatch(/how many nights/i);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
  });

  it("copes with a caller changing their mind and asking a side question mid-booking", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.say("I want to book a Deluxe King room for tomorrow for two nights");
    const side = await c.say("wait, what time is check-out?");
    expect(side.reply).toMatch(/11 AM/);
    expect(side.reply).toMatch(/how many guests/i); // it keeps its place in the booking
    await c.say("two guests");
    const changed = await c.say("actually make it three nights");
    expect(changed.reply).toMatch(/name for the reservation/i);
    const confirm = await c.say("Dana Wu");
    expect(confirm.reply).toMatch(/3 nights/);
    expect(confirm.reply).toMatch(/\$567/);
  });

  it("recovers when the caller says no at the confirmation step", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.sayAll("Book a Family Room for tomorrow for two nights", "four guests", "Lee Park");
    const no = await c.say("no, that's not right");
    expect(no.reply).toMatch(/what would you like to change/i);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
  });

  it("tolerates filler words and noisy transcripts", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const t = await c.say("uh... um, yeah I wanna book a, uh, deluxe king room, um, tomorrow, for like two nights");
    expect(t.reply).toMatch(/how many guests/i);
  });

  it("stops and hands off after repeated unintelligible answers rather than guessing", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.say("book a deluxe king room tomorrow for two nights");
    await c.say("blah blah");
    await c.say("kkzzt mmm");
    const t = await c.say("zzz qqq");
    expect(t.reply).toMatch(/wasn't able to complete/i);
    expect(t.reply).toMatch(/call you back/i);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBeGreaterThan(0);
  });

  it("keeps what it captured when the line drops mid-booking, and confirms nothing", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.sayAll("book a deluxe king room tomorrow for two nights", "two guests");
    await c.hangUp(); // caller disconnects
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
    const fu = (await FollowUp.findOne({ callId: c.call._id }))!;
    expect(fu.reason).toMatch(/ended before the reserve request was finished/i);
    expect(fu.reason).toMatch(/NOTHING was confirmed/);
    expect(fu.reason).toMatch(/guests 2/);
  });

  it("falls back safely when the booking system is down: no false confirmation, human follow-up created", async () => {
    const tb = await createHotel();
    const native = nativeBookingProviderForTest();
    __setProvidersForTest([{ ...native, createReservation: async () => { throw new Error("PMS timeout"); } }]);
    const c = await Conversation.start(tb);
    await c.sayAll("Book a Deluxe King room for tomorrow for two nights", "two guests", "Casey North");
    const t = await c.say("yes");
    expect(t.reply).not.toMatch(/is confirmed/i);
    expect(t.reply).toMatch(/wasn't able to complete/i);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
    const fu = (await FollowUp.findOne({ callId: c.call._id }))!;
    expect(fu.priority).toBe("high");
    const call = (await Call.findById(c.call._id))!;
    expect(call.metrics!.toolFailures).toBeGreaterThan(0);
  });

  it("falls back when availability cannot be checked at all", async () => {
    const tb = await createHotel();
    __setProvidersForTest([{ ...nativeBookingProviderForTest(), checkAvailability: async () => { throw new Error("down"); } }]);
    const c = await Conversation.start(tb);
    const t = await c.say("Book a Deluxe King room for tomorrow for two nights for two guests");
    expect(t.reply).toMatch(/wasn't able to complete/i);
    expect(t.reply).not.toMatch(/available for/i);
  });

  it("keeps businesses completely separate: a code from hotel A is not found at hotel B", async () => {
    const a = await createHotel();
    const b = await createHotel();
    const res = await bookDirect(a, { inDays: 3, nights: 1, guest: "Pat Lee" });
    const cb = await Conversation.start(b);
    const direct = await runTool("lookup_reservation", { businessId: b.business._id, callId: cb.call._id }, { confirmationCode: res.confirmationCode, guestLastName: "Lee" });
    expect(direct).toMatchObject({ ok: true, data: { done: false, reason: "not_found" } });
    const t = await cb.say("I want to check my reservation " + spell(res.confirmationCode));
    expect(t.reply).toMatch(/couldn't find a reservation/i);
  });
});

describe("changing and cancelling a reservation", () => {
  it("verifies the caller, changes the dates, and sends any price difference for human approval", async () => {
    const tb = await createHotel();
    const res = await bookDirect(tb, { inDays: 10, nights: 2 });
    const c = await Conversation.start(tb, { callerNumber: "+15551110000" }); // not the number on the booking
    expect((await c.say("I need to change my reservation")).reply).toMatch(/confirmation code/i);
    const ask = await c.say(spell(res.confirmationCode));
    expect(ask.reply).toMatch(/last name/i); // phone doesn't match -> must verify
    const found = await c.say("Lee");
    expect(found.reply).toMatch(/What would you like to change/i);
    const confirm = await c.say("extend it by one night");
    expect(confirm.reply).toMatch(/3 nights/);
    expect(confirm.reply).toMatch(/\$189 more/);
    expect(confirm.reply).toMatch(/team would need to approve/i);
    const done = await c.say("yes");
    expect(done.reply).toMatch(/^Done\./);

    const after = (await Reservation.findOne({ confirmationCode: res.confirmationCode }))!;
    expect(after).toMatchObject({ status: "modified", nights: 3, checkOut: addDays(today(), 13), totalAmount: 567 });
    const pay = (await PaymentApproval.findOne({ businessId: tb.business._id }))!;
    expect(pay).toMatchObject({ kind: "adjustment", status: "pending", amount: 189 });
    expect(done.reply).toMatch(/nothing has been charged or refunded yet/i);
  });

  it("does not reveal or change a reservation when the caller cannot be verified", async () => {
    const tb = await createHotel();
    const res = await bookDirect(tb, { inDays: 10, nights: 2 });
    const c = await Conversation.start(tb, { callerNumber: "+15551110000" });
    await c.sayAll("I need to change my reservation", spell(res.confirmationCode));
    const t = await c.say("Smith"); // wrong last name
    expect(t.reply).toMatch(/wasn't able to complete/i);
    expect(t.reply).not.toMatch(/Deluxe King/);
    const same = (await Reservation.findOne({ confirmationCode: res.confirmationCode }))!;
    expect(same).toMatchObject({ status: "confirmed", nights: 2 });
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBeGreaterThan(0);
  });

  it("cancels only after an explicit yes, and never promises a refund", async () => {
    const tb = await createHotel();
    const res = await bookDirect(tb, { inDays: 10, nights: 2, phone: "+15551110000" });
    const c = await Conversation.start(tb, { callerNumber: "+15551110000" }); // caller ID matches -> verified without a name
    const ask = await c.say(`I want to cancel my reservation ${spell(res.confirmationCode)}`);
    expect(ask.reply).toMatch(/would you like me to cancel it/i);
    expect((await Reservation.findOne({ confirmationCode: res.confirmationCode }))!.status).toBe("confirmed");
    const done = await c.say("yes cancel it");
    expect(done.reply).toMatch(/is cancelled/i);
    expect(done.reply).toMatch(/can't promise a refund/i);
    expect((await Reservation.findOne({ confirmationCode: res.confirmationCode }))!.status).toBe("cancelled");
    expect(await PaymentApproval.countDocuments({ businessId: tb.business._id })).toBe(0); // no refund was created or implied
  });

  it("frees the room when a reservation is cancelled", async () => {
    const tb = await createHotel({ rooms: [{ name: "Deluxe King Room", nightlyRate: 189, capacity: 2, totalUnits: 1 }] });
    const res = await bookDirect(tb, { inDays: 4, nights: 2 });
    const p = (await getBookingProvider(tb.business._id))!;
    const q = { checkIn: addDays(today(), 4), checkOut: addDays(today(), 6) };
    expect((await p.checkAvailability(tb.business._id, q))[0].available).toBe(0);
    await p.cancelReservation(tb.business._id, res.confirmationCode);
    expect((await p.checkAvailability(tb.business._id, q))[0].available).toBe(1);
  });

  it("handles a mistyped or unknown confirmation code gracefully", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.say("I want to cancel my booking");
    const t = await c.say("S D A A A A A A");
    expect(t.reply).toMatch(/couldn't find a reservation/i);
  });
});

describe("payments require human approval", () => {
  it("prepares a payment request, tells staff, and never claims money moved", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const a = await c.say("I'd like to pay a deposit for my stay");
    expect(a.reply).toMatch(/can't take card details/i);
    await c.say("no I don't have the code");
    const done = await c.say("Sam Ortiz");
    expect(done.reply).toMatch(/for approval/i);
    expect(done.reply).toMatch(/can't confirm anything has been charged/i);
    expect(done.reply).not.toMatch(/\b(you('ve| have) been charged|payment (was|is) (successful|complete|received)|is paid|was paid|we('ve| have) charged)\b/i);

    const pay = (await PaymentApproval.findOne({ businessId: tb.business._id }))!;
    expect(pay).toMatchObject({ kind: "charge", status: "pending", customerName: "Sam Ortiz" });
    expect(pay.paymentRef).toBeUndefined();
    expect(await FollowUp.countDocuments({ businessId: tb.business._id, reason: /Payment approval needed/ })).toBe(1);
    expect(await Notification.countDocuments({ businessId: tb.business._id, type: "payment_approval" })).toBe(1);
  });

  it("creates a refund request (not a refund) when a caller asks for money back", async () => {
    const tb = await createHotel();
    const res = await bookDirect(tb, { inDays: 20, nights: 2 });
    const c = await Conversation.start(tb);
    await c.say("I want a refund for my stay");
    await c.say(spell(res.confirmationCode));
    const t = await c.say("Pat Lee");
    expect(t.reply).toMatch(/refund request/i);
    expect(t.reply).toMatch(/can't confirm anything has been refunded/i);
    const pay = (await PaymentApproval.findOne({ businessId: tb.business._id }))!;
    expect(pay).toMatchObject({ kind: "refund", status: "pending", amount: 378 });
  });

  it("rejects raw card fields at the tool level and scrubs card numbers from transcripts", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const tool = await runTool("request_payment_approval", { businessId: tb.business._id, callId: c.call._id }, { kind: "charge", description: "deposit", cardNumber: "4111111111111111" });
    expect(tool).toMatchObject({ ok: false, error: { code: "validation_error" } });

    const t = await c.say("sure my card number is 4111 1111 1111 1111 and the cvv is 123");
    expect(t.reply).toMatch(/please don't share card or ID numbers/i);
    const tr = (await CallTranscript.findOne({ callId: c.call._id }))!;
    const all = tr.segments.map((s) => s.text).join(" ");
    expect(all).not.toMatch(/4111/);
    expect(all).toMatch(/\[card number removed\]|withheld/);
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBe(1);
  });

  it("only owners/admins can approve; approval alone is not 'paid'; paid needs the payment system's reference", async () => {
    const tb = await createHotel({ withUser: true });
    const c = await Conversation.start(tb);
    await c.sayAll("I'd like to pay a deposit", "no", "Sam Ortiz");
    const pay = (await PaymentApproval.findOne({ businessId: tb.business._id }))!;

    const owner = await login(tb.userEmail);
    const staffRes = await owner.post("/api/team").send({ name: "Stan", email: `stan-${Date.now()}@example.test`, password: "Password123!", role: "staff" });
    const staff = await login(staffRes.body.user.email);
    expect((await staff.post(`/api/payment-approvals/${pay._id}`).send({ action: "approve" })).status).toBe(403);
    expect((await staff.get("/api/payment-approvals")).body.pending).toBe(1); // staff can see, not decide

    const approved = await owner.post(`/api/payment-approvals/${pay._id}`).send({ action: "approve", note: "OK, call guest" });
    expect(approved.body.approval).toMatchObject({ status: "approved" });
    expect(approved.body.approval.paymentRef).toBeUndefined(); // approved, not yet paid
    expect((await owner.post(`/api/payment-approvals/${pay._id}`).send({ action: "approve" })).status).toBe(409); // can't decide twice
    expect((await owner.post(`/api/payment-approvals/${pay._id}`).send({ action: "mark_paid" })).status).toBe(400); // needs a reference
    const paid = await owner.post(`/api/payment-approvals/${pay._id}`).send({ action: "mark_paid", reference: "POS-7781" });
    expect(paid.body.approval).toMatchObject({ status: "paid", paymentRef: "POS-7781" });
  });

  it("rejection is final and recorded", async () => {
    const tb = await createHotel({ withUser: true });
    const c = await Conversation.start(tb);
    await c.sayAll("I'd like to pay a deposit", "no", "Sam Ortiz");
    const pay = (await PaymentApproval.findOne({ businessId: tb.business._id }))!;
    const owner = await login(tb.userEmail);
    const res = await owner.post(`/api/payment-approvals/${pay._id}`).send({ action: "reject", note: "Policy" });
    expect(res.body.approval.status).toBe("rejected");
    expect((await owner.post(`/api/payment-approvals/${pay._id}`).send({ action: "mark_paid", reference: "X" })).status).toBe(409);
  });

  it("another business can never see or decide this business's approvals", async () => {
    const a = await createHotel();
    const b = await createHotel({ withUser: true });
    const c = await Conversation.start(a);
    await c.sayAll("I'd like to pay a deposit", "no", "Sam Ortiz");
    const pay = (await PaymentApproval.findOne({ businessId: a.business._id }))!;
    const ownerB = await login(b.userEmail);
    expect((await ownerB.get("/api/payment-approvals?status=all")).body.approvals).toHaveLength(0);
    expect((await ownerB.post(`/api/payment-approvals/${pay._id}`).send({ action: "approve" })).status).toBe(404);
  });
});

describe("guest service and front-desk requests", () => {
  it("creates a service request with the room number", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    await c.say("The shower in room 214 isn't working");
    expect(await ServiceRequest.countDocuments({ businessId: tb.business._id, location: /214/ })).toBe(1);
  });

  it("passes early check-in requests to staff without promising them", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    const a = await c.say("Can I get an early check-in tomorrow around noon?");
    expect(a.reply).toMatch(/can't guarantee/i);
    const b = await c.say("Jamie Cole");
    expect(b.reply).toMatch(/isn't guaranteed yet/i);
    expect(await ServiceRequest.countDocuments({ businessId: tb.business._id, description: /Early check-in/ })).toBe(1);
  });
});

describe("honesty and escalation", () => {
  it("answers truthfully that it is an AI, but still transfers when asked for a person", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb);
    expect((await c.say("Are you a real person?")).reply).toMatch(/I'm an AI assistant/);
    const t = await c.say("Can I speak to a real person please?");
    expect(t.reply).toMatch(/connect|nobody on our team/i);
  });

  it("transfers on request and falls back to a callback when nobody answers", async () => {
    const tb = await createHotel();
    const c = await Conversation.start(tb, { transferAnswers: false });
    const t = await c.say("I want to speak to a manager");
    expect(t.reply).toMatch(/nobody on our team is available/i);
    expect(await FollowUp.countDocuments({ callId: c.call._id })).toBeGreaterThan(0);
  });

  it("works with no booking system connected: captures an inquiry for staff instead of confirming anything", async () => {
    const tb = await createHotel({ rooms: null });
    const c = await Conversation.start(tb);
    await c.say("I'd like to book a Deluxe King room tomorrow for two nights");
    const t = await c.say("My name is Riley Park");
    expect(t.reply).toMatch(/passed your booking request to our team/i);
    expect(t.reply).not.toMatch(/confirmation code|is confirmed/i);
    expect(await Reservation.countDocuments({ businessId: tb.business._id })).toBe(0);
    expect(await Opportunity.countDocuments({ businessId: tb.business._id, status: "new" })).toBe(1);
  });
});

describe("healthcare office rules", () => {
  it("refuses medical advice, withholds clinical details from the transcript, and escalates to staff", async () => {
    const tb = await createClinic();
    const c = await Conversation.start(tb);
    const t = await c.say("I have a rash and a fever, what medication should I take?");
    expect(t.reply).toMatch(/not able to give medical advice/i);
    expect(t.reply).not.toMatch(/ibuprofen|tylenol|mg\b/i);
    const tr = (await CallTranscript.findOne({ callId: c.call._id }))!;
    expect(tr.segments.map((s) => s.text).join(" ")).not.toMatch(/rash|fever/i);
    expect(await FollowUp.countDocuments({ callId: c.call._id, priority: "high" })).toBe(1);
  });

  it("sends emergencies to 911 and alerts staff", async () => {
    const tb = await createClinic();
    const c = await Conversation.start(tb);
    const t = await c.say("I'm having chest pain");
    expect(t.reply).toMatch(/911/);
    expect(await FollowUp.countDocuments({ callId: c.call._id, priority: "urgent" })).toBe(1);
    expect(await Notification.countDocuments({ businessId: tb.business._id, type: "urgent_request" })).toBe(1);
  });

  it("never discloses patient information by phone", async () => {
    const tb = await createClinic();
    const c = await Conversation.start(tb);
    const r = await runTool("lookup_existing_customer", { businessId: tb.business._id, callId: c.call._id }, {});
    expect(r).toMatchObject({ ok: true, data: { found: false, privacy: true } });
  });

  it("still handles administrative questions (location, new patients)", async () => {
    const tb = await createClinic();
    const c = await Conversation.start(tb);
    expect((await c.say("Where are you located?")).reply).toMatch(/5 Main Street/);
    expect((await c.say("Are you accepting new patients?")).reply).toMatch(/accepting new patients/i);
  });
});
