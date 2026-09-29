import { describe, expect, it } from "vitest";
import { Call, FollowUp, Notification } from "../server/models";
import { makeBusiness, newCallSid, twilioPost } from "./helpers";

const INCOMING = "/api/twilio/incoming";

async function callInTransfer(humanNumber = "+15557778888") {
  const biz = await makeBusiness({ aiOnly: true, humanNumber });
  const sid = newCallSid();
  await twilioPost(INCOMING, { CallSid: sid, From: "+15551230000", To: biz.config.twilioNumber! });
  const call = (await Call.findOne({ providerCallId: sid }))!;
  const gather = (speech: string) => twilioPost(`/api/twilio/gather?callId=${call._id}`, { CallSid: sid, SpeechResult: speech });
  const asked = await gather("Can I speak to a real person please?");
  return { biz, sid, call, asked };
}

describe("human transfer over the phone", () => {
  it("dials the escalation number when the caller asks for a person", async () => {
    const { call, asked } = await callInTransfer();
    expect(asked.text).toContain("hold");
    expect(asked.text).toMatch(/<Dial[^>]*>\s*<Number>\+15557778888<\/Number>/);
    expect(asked.text).toContain("transfer-result");
    const c = (await Call.findById(call._id))!;
    expect(c).toMatchObject({ transferAttempted: true, transferStatus: "ringing", intent: "human_request" });
    expect(c.transfer?.transferNumber).toBe("+15557778888");
  });

  it("marks the call transferred when staff answer", async () => {
    const { sid, call } = await callInTransfer();
    const res = await twilioPost(`/api/twilio/transfer-result?callId=${call._id}`, { CallSid: sid, DialCallStatus: "completed", DialCallDuration: "120" });
    expect(res.status).toBe(200);
    const c = (await Call.findById(call._id))!;
    expect(c).toMatchObject({ transferStatus: "answered", handledBy: "ai_and_human", status: "human_transferred" });
    expect(c.transfer?.transferAnsweredAt).toBeInstanceOf(Date);

    await twilioPost("/api/twilio/status", { CallSid: sid, CallStatus: "completed", CallDuration: "150" });
    expect((await Call.findById(call._id))).toMatchObject({ outcome: "transferred", status: "human_transferred" });
  });

  it("failed transfer: AI resumes, follow-up is created and the owner is alerted", async () => {
    const { biz, sid, call } = await callInTransfer();
    const res = await twilioPost(`/api/twilio/transfer-result?callId=${call._id}`, { CallSid: sid, DialCallStatus: "no-answer" });
    expect(res.text).toContain("<Gather"); // conversation continues
    expect(res.text).toContain("nobody on our team is available");

    const c = (await Call.findById(call._id))!;
    expect(c).toMatchObject({ transferStatus: "no_answer", handledBy: "ai", pendingTransfer: false });
    expect(c.transfer?.attempts?.[0]?.status).toBe("no_answer");
    expect(await FollowUp.countDocuments({ callId: call._id, priority: "high" })).toBe(1);
    expect((await Notification.find({ businessId: biz.business._id })).map((n) => n.type)).toContain("transfer_failed");

    // The AI keeps helping after the failed transfer.
    const next = await twilioPost(`/api/twilio/gather?callId=${call._id}`, { CallSid: sid, SpeechResult: "What time is check out?" });
    expect(next.text).toContain("<Gather");
  });

  it("a busy escalation line counts as a failed transfer", async () => {
    const { sid, call } = await callInTransfer();
    await twilioPost(`/api/twilio/transfer-result?callId=${call._id}`, { CallSid: sid, DialCallStatus: "busy" });
    expect((await Call.findById(call._id))!.transferStatus).toBe("failed");
  });
});
