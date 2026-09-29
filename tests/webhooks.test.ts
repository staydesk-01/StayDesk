import { describe, expect, it } from "vitest";
import { Call, CallSummary, FollowUp, Notification } from "../server/models";
import { findBusinessByNumber } from "../server/services/business/businessService";
import { makeBusiness, newCallSid, request, twilioPost } from "./helpers";

const INCOMING = "/api/twilio/incoming";
const params = (biz: { config: { twilioNumber?: string | null } }, sid = newCallSid(), from = "+15551230000") => ({ CallSid: sid, From: from, To: biz.config.twilioNumber!, CallStatus: "ringing" });

describe("business lookup by phone number", () => {
  it("matches the dialled number regardless of formatting", async () => {
    const biz = await makeBusiness({ twilioNumber: "+15558675309" });
    for (const dialled of ["+15558675309", "(555) 867-5309", "1-555-867-5309", "5558675309"]) {
      const found = await findBusinessByNumber(dialled);
      expect(String(found?.business._id)).toBe(String(biz.business._id));
    }
  });
  it("returns null for unknown numbers", async () => {
    await makeBusiness({ twilioNumber: "+15558675309" });
    expect(await findBusinessByNumber("+15550009999")).toBeNull();
    expect(await findBusinessByNumber("")).toBeNull();
  });
});

describe("POST /api/twilio/incoming", () => {
  it("rejects an invalid signature and creates no call", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const res = await twilioPost(INCOMING, params(biz), { signature: "bogus" });
    expect(res.status).toBe(403);
    expect(await Call.countDocuments()).toBe(0);
  });

  it("rejects a request with no signature", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const res = await request().post(INCOMING).type("form").send(params(biz));
    expect(res.status).toBe(403);
  });

  it("rejects a signature computed over different params (tampering)", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const p = params(biz);
    const good = (await twilioPost(INCOMING, p)).status;
    expect(good).toBe(200);
    const twilio = (await import("twilio")).default;
    const sig = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, `https://staydesk.test${INCOMING}`, p);
    const res = await twilioPost(INCOMING, { ...p, From: "+19998887777" }, { signature: sig });
    expect(res.status).toBe(403);
  });

  it("answers politely and creates no call for an unknown business number", async () => {
    await makeBusiness();
    const res = await twilioPost(INCOMING, { CallSid: newCallSid(), From: "+15551230000", To: "+15559999999" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("not currently in service");
    expect(res.text).toContain("<Hangup");
    expect(await Call.countDocuments()).toBe(0);
  });

  it("creates a call session and greets with the AI when AI-only", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const p = params(biz);
    const res = await twilioPost(INCOMING, p);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
    expect(res.text).toContain("<Gather");
    expect(res.text).toContain(biz.business.name);

    const call = await Call.findOne({ providerCallId: p.CallSid });
    expect(call).toBeTruthy();
    expect(String(call!.businessId)).toBe(String(biz.business._id));
    expect(call).toMatchObject({ provider: "twilio", callerNumber: "+15551230000", businessNumber: biz.config.twilioNumber, routingReason: "direct_ai", status: "ai_answered", handledBy: "ai" });
    expect(call!.startedAt).toBeInstanceOf(Date);
  });

  it("is idempotent when Twilio retries the webhook", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const p = params(biz);
    await twilioPost(INCOMING, p);
    await twilioPost(INCOMING, p);
    expect(await Call.countDocuments({ providerCallId: p.CallSid })).toBe(1);
  });
});

describe("routing", () => {
  it("rings the human first when open and human-first is enabled", async () => {
    const biz = await makeBusiness({ humanNumber: "+15550001111" });
    const res = await twilioPost(INCOMING, params(biz));
    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("+15550001111");
    const call = await Call.findOne();
    expect(call).toMatchObject({ handledBy: "human", status: "ringing" });
  });

  it("routes straight to AI after hours", async () => {
    const biz = await makeBusiness({ open: false });
    const res = await twilioPost(INCOMING, params(biz));
    expect(res.text).toContain("<Gather");
    expect(res.text).not.toContain("<Dial");
    const call = await Call.findOne();
    expect(call).toMatchObject({ routingReason: "after_hours", handledBy: "ai", status: "ai_answered" });
  });

  it("routes to AI as overflow when the human line is already occupied", async () => {
    const biz = await makeBusiness({ maxConcurrentHumanCalls: 1 });
    await twilioPost(INCOMING, params(biz)); // first caller rings the human
    const second = params(biz, newCallSid(), "+15559990000");
    const res = await twilioPost(INCOMING, second);
    expect(res.text).toContain("<Gather");
    expect(await Call.findOne({ providerCallId: second.CallSid })).toMatchObject({ routingReason: "overflow", handledBy: "ai" });
  });

  it("treats calls to a forwarded existing number as AI overflow", async () => {
    const biz = await makeBusiness({ mode: "existing_number" });
    await twilioPost(INCOMING, params(biz));
    expect(await Call.findOne()).toMatchObject({ routingReason: "no_answer", handledBy: "ai" });
  });

  it.each([
    ["no-answer", "no_answer"],
    ["busy", "busy"],
  ])("falls back to AI when the human dial ends %s", async (dialStatus, reason) => {
    const biz = await makeBusiness();
    const p = params(biz);
    await twilioPost(INCOMING, p);
    const call = (await Call.findOne({ providerCallId: p.CallSid }))!;
    const res = await twilioPost(`/api/twilio/dial-result?callId=${call._id}`, { CallSid: p.CallSid, DialCallStatus: dialStatus });
    expect(res.text).toContain("<Gather");
    const after = (await Call.findById(call._id))!;
    expect(after).toMatchObject({ routingReason: reason, handledBy: "ai", status: "ai_answered" });
  });

  it("keeps human-handled calls human when the staff member answers", async () => {
    const biz = await makeBusiness();
    const p = params(biz);
    await twilioPost(INCOMING, p);
    const call = (await Call.findOne())!;
    await twilioPost(`/api/twilio/dial-result?callId=${call._id}`, { CallSid: p.CallSid, DialCallStatus: "completed", DialCallDuration: "95" });
    await twilioPost("/api/twilio/status", { CallSid: p.CallSid, CallStatus: "completed", CallDuration: "96" });
    const done = (await Call.findById(call._id))!;
    expect(done).toMatchObject({ handledBy: "human", status: "completed" });
    expect(done.durationSeconds).toBe(96);
  });

  it("refuses a dial-result callback whose callId does not match the CallSid", async () => {
    const biz = await makeBusiness();
    const p = params(biz);
    await twilioPost(INCOMING, p);
    const call = (await Call.findOne())!;
    const res = await twilioPost(`/api/twilio/dial-result?callId=${call._id}`, { CallSid: "CAsomeoneelse", DialCallStatus: "no-answer" });
    expect(res.text).toContain("technical difficulties"); // safe fallback, no state change
    expect((await Call.findById(call._id))!.handledBy).toBe("human");
  });
});

describe("AI conversation over the phone", () => {
  async function startAiCall() {
    const biz = await makeBusiness({ aiOnly: true });
    const p = params(biz);
    await twilioPost(INCOMING, p);
    const call = (await Call.findOne({ providerCallId: p.CallSid }))!;
    const say = (speech: string) => twilioPost(`/api/twilio/gather?callId=${call._id}`, { CallSid: p.CallSid, SpeechResult: speech });
    return { biz, p, call, say };
  }

  it("runs the full success scenario: AI captures a booking, saves a summary, and the call completes", async () => {
    const { biz, p, call, say } = await startAiCall();
    await say("Hi, I'd like to book a deluxe king room for this Friday");
    await say("Two nights, two guests");
    const captured = await say("My name is John Carter");
    expect(captured.text).toContain("passed your booking request");

    await say("No, that's all. Bye");
    await twilioPost("/api/twilio/status", { CallSid: p.CallSid, CallStatus: "completed", CallDuration: "84" });

    const done = (await Call.findById(call._id))!;
    expect(done).toMatchObject({ status: "completed", outcome: "opportunity_captured", intent: "booking_inquiry", followUpRequired: true, durationSeconds: 84 });
    expect(done.summaryId).toBeTruthy();
    expect((await CallSummary.findOne({ callId: call._id }))!.summary).toContain("John Carter");
    expect(await FollowUp.countDocuments({ callId: call._id })).toBe(1);
    const alerts = await Notification.find({ businessId: biz.business._id });
    expect(alerts.map((n) => n.type)).toContain("booking_inquiry");
  });

  it("re-prompts on silence and hangs up after repeated silence", async () => {
    const { call, p } = await startAiCall();
    const url = `/api/twilio/gather?callId=${call._id}`;
    expect((await twilioPost(url, { CallSid: p.CallSid, SpeechResult: "" })).text).toContain("<Gather");
    expect((await twilioPost(url, { CallSid: p.CallSid, SpeechResult: "" })).text).toContain("<Gather");
    expect((await twilioPost(url, { CallSid: p.CallSid, SpeechResult: "" })).text).toContain("<Hangup");
  });

  it("marks a call abandoned (with a follow-up) when the caller hangs up before speaking", async () => {
    const { call, p } = await startAiCall();
    await twilioPost("/api/twilio/status", { CallSid: p.CallSid, CallStatus: "completed", CallDuration: "5" });
    const done = (await Call.findById(call._id))!;
    expect(done).toMatchObject({ status: "abandoned", outcome: "abandoned", followUpRequired: true });
  });

  it("finalizes exactly once even if the status callback is delivered twice", async () => {
    const { call, p, say } = await startAiCall();
    await say("What are your hours?");
    const status = { CallSid: p.CallSid, CallStatus: "completed", CallDuration: "40" };
    await Promise.all([twilioPost("/api/twilio/status", status), twilioPost("/api/twilio/status", status)]);
    expect(await CallSummary.countDocuments({ callId: call._id })).toBe(1);
  });
});
