import { afterEach, describe, expect, it, vi } from "vitest";
import { Business, Call, CustomerProfile, FollowUp } from "../server/models";
import { agentEngine } from "../server/services/ai/agentEngine";
import { buildCompletion, pickOriginalRequest } from "../server/services/calls/completion";
import { forgetCaller, recallCaller } from "../server/services/memory/customerMemory";
import { voiceTiming } from "../server/config/flags";
import { login, makeBusiness, newCallSid, request, twilioPost } from "./helpers";

const FROM = "+15557001234";
const FLAGS = ["FEATURE_CUSTOMER_MEMORY", "FEATURE_RETURNING_GREETING", "FEATURE_COMPLETION_TRACKING", "FEATURE_RESILIENT_TURNS", "FEATURE_VOICE_TUNING", "VOICE_SPEECH_TIMEOUT", "VOICE_NO_INPUT_SECONDS"];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of FLAGS) delete process.env[f];
});

async function phoneCall(biz: Awaited<ReturnType<typeof makeBusiness>>, from = FROM, lines: string[] = []) {
  const sid = newCallSid();
  const first = await twilioPost("/api/twilio/incoming", { CallSid: sid, From: from, To: biz.config.twilioNumber!, CallStatus: "ringing" });
  const call = (await Call.findOne({ providerCallId: sid }))!;
  const say = (speech: string) => twilioPost(`/api/twilio/gather?callId=${call._id}`, { CallSid: sid, SpeechResult: speech });
  for (const l of lines) await say(l);
  const end = () => twilioPost("/api/twilio/status", { CallSid: sid, CallStatus: "completed", CallDuration: "40" });
  return { sid, call, first, say, end };
}

describe("caller memory", () => {
  it("remembers a caller after a call and recognises them next time, without any personal detail", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const c1 = await phoneCall(biz, FROM, ["Hi, I'd like to book a deluxe king room for this Friday", "Two nights, two guests", "My name is John Carter"]);
    await c1.end();
    const profile = (await CustomerProfile.findOne({ businessId: biz.business._id }))!;
    expect(profile).toMatchObject({ phone: FROM, callCount: 1, name: "John Carter" });
    expect(profile.interactions[0].request).toContain("deluxe king");

    const c2 = await phoneCall(biz);
    const state = (await Call.findById(c2.call._id))!.agentState as { memory?: Record<string, unknown> };
    expect(state.memory).toMatchObject({ returning: true, callCount: 1 });
    expect(JSON.stringify(state.memory)).not.toMatch(/John|Carter|deluxe/i); // recognition carries no personal detail
    expect(c2.first.text).not.toMatch(/welcome back/i); // greeting stays unchanged by default
  });

  it("greets a returning caller with 'Welcome back' only when the flag is on, and never by name", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    await (await phoneCall(biz, FROM, ["What are your hours?"])).end();
    process.env.FEATURE_RETURNING_GREETING = "true";
    const c2 = await phoneCall(biz);
    expect(c2.first.text).toMatch(/welcome back/i);
    expect(c2.first.text).not.toMatch(/John|Carter/);
    const stranger = await phoneCall(biz, "+15557009999");
    expect(stranger.first.text).not.toMatch(/welcome back/i);
  });

  it("keeps businesses separate", async () => {
    const a = await makeBusiness({ aiOnly: true });
    const b = await makeBusiness({ aiOnly: true });
    await (await phoneCall(a, FROM, ["What are your hours?"])).end();
    expect(await recallCaller(a.business._id, FROM)).not.toBeNull();
    expect(await recallCaller(b.business._id, FROM)).toBeNull();
  });

  it("stores no free text for medical businesses", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    await Business.updateOne({ _id: biz.business._id }, { type: "medical" });
    await (await phoneCall(biz, FROM, ["I need to see someone about my knee pain"])).end();
    const p = (await CustomerProfile.findOne({ businessId: biz.business._id }))!;
    expect(p.callCount).toBe(1);
    expect(p.interactions[0].request).toBe("");
    expect(p.name).toBe("");
    process.env.FEATURE_RETURNING_GREETING = "true";
    expect((await phoneCall(biz)).first.text).not.toMatch(/welcome back/i);
  });

  it("does nothing when the flag is off", async () => {
    process.env.FEATURE_CUSTOMER_MEMORY = "false";
    const biz = await makeBusiness({ aiOnly: true });
    await (await phoneCall(biz, FROM, ["What are your hours?"])).end();
    expect(await CustomerProfile.countDocuments()).toBe(0);
  });

  it("does not double count a call finalised twice, and redacts card numbers", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const c = await phoneCall(biz, FROM, ["Hi I want to book a room, my card is 4111 1111 1111 1111"]);
    await c.end();
    await c.end();
    const p = (await CustomerProfile.findOne({ businessId: biz.business._id }))!;
    expect(p.callCount).toBe(1);
    expect(JSON.stringify(p)).not.toContain("4111");
  });

  it("erasure removes the data; opt-out keeps a data-free marker so the number is not remembered again", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    await (await phoneCall(biz, FROM, ["What are your hours?"])).end();
    const owner = await login(biz.email);
    const list = await owner.get("/api/customers");
    expect(list.body.customers).toHaveLength(1);
    const id = list.body.customers[0]._id;

    expect((await owner.delete(`/api/customers/${id}?optOut=true`)).status).toBe(200);
    const marker = (await CustomerProfile.findById(id))!;
    expect(marker).toMatchObject({ optedOut: true, callCount: 0, name: "" });
    expect(marker.interactions).toHaveLength(0);
    await (await phoneCall(biz, FROM, ["What are your hours?"])).end();
    expect((await CustomerProfile.findById(id))!.callCount).toBe(0);

    expect(await forgetCaller(biz.business._id, FROM)).toBe(true);
    expect(await CustomerProfile.countDocuments()).toBe(0);
  });

  it("is available to owners only and scoped to their business", async () => {
    const a = await makeBusiness({ aiOnly: true });
    const b = await makeBusiness({ aiOnly: true });
    await (await phoneCall(a, FROM, ["What are your hours?"])).end();
    const id = (await CustomerProfile.findOne({ businessId: a.business._id }))!._id;
    expect((await request().get("/api/customers")).status).toBe(401);
    const other = await login(b.email);
    expect((await other.get("/api/customers")).body.customers).toHaveLength(0);
    expect((await other.delete(`/api/customers/${id}`)).status).toBe(404);
  });
});

describe("call-to-completion tracking", () => {
  it("records request, attempts, real outcomes and next steps", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const c = await phoneCall(biz, FROM, ["Hi, I'd like to book a deluxe king room for this Friday", "Two nights, two guests", "My name is John Carter", "No, that's all. Bye"]);
    await c.end();
    const done = (await Call.findById(c.call._id))!;
    const rec = done.completion as Awaited<ReturnType<typeof buildCompletion>>;
    expect(rec.originalRequest).toContain("deluxe king");
    expect(rec.intent).toBe("booking_inquiry");
    expect(rec.attempted.some((a) => a.tool === "create_booking_or_lead" && a.result === "success")).toBe(true);
    expect(rec.outcomes.map((o) => o.type)).toEqual(expect.arrayContaining(["opportunity", "follow_up"]));
    expect(rec.status).toBe("needs_follow_up"); // staff still have to confirm: the record must not claim it was fulfilled
    expect(rec.nextSteps.length).toBeGreaterThan(0);
  });

  it("marks an information-only call as answered", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const c = await phoneCall(biz, FROM, ["Do you have parking?", "No thanks, bye"]);
    await c.end();
    const rec = (await Call.findById(c.call._id))!.completion as { status: string; failures: unknown[] };
    expect(rec.status).toBe("answered");
    expect(rec.failures).toHaveLength(0);
  });

  it("marks a hang-up before speaking as abandoned", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const c = await phoneCall(biz);
    await c.end();
    expect(((await Call.findById(c.call._id))!.completion as { status: string }).status).toBe("abandoned");
  });

  it("can be switched off", async () => {
    process.env.FEATURE_COMPLETION_TRACKING = "false";
    const biz = await makeBusiness({ aiOnly: true });
    const c = await phoneCall(biz, FROM, ["Do you have parking?"]);
    await c.end();
    expect((await Call.findById(c.call._id))!.completion).toBeUndefined();
  });

  it("picks the first real request, not the greeting", () => {
    expect(pickOriginalRequest([{ role: "caller", text: "Hello" }, { role: "caller", text: "I need a room for Friday night" }])).toBe("I need a room for Friday night");
    expect(pickOriginalRequest([])).toBe("");
  });
});

describe("turn reliability and timing", () => {
  it("recovers from an unexpected error by asking the caller to repeat, then hands off after repeated errors", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const c = await phoneCall(biz);
    vi.spyOn(agentEngine, "respond").mockRejectedValue(new Error("boom"));
    const r1 = await c.say("What are your hours?");
    expect(r1.text).toContain("<Gather");
    expect(r1.text).toMatch(/Could you say it again/);
    await c.say("What are your hours?");
    const r3 = await c.say("What are your hours?");
    expect(r3.text).toContain("<Hangup");
    expect(r3.text).toMatch(/call you back/);
    expect(await FollowUp.countDocuments({ callId: c.call._id, priority: "high" })).toBe(1);
    expect((await Call.findById(c.call._id))!.voice?.recoveredErrors).toBe(3);
  });

  it("falls back to the technical-difficulties message when the flag is off", async () => {
    process.env.FEATURE_RESILIENT_TURNS = "false";
    const biz = await makeBusiness({ aiOnly: true });
    const c = await phoneCall(biz);
    vi.spyOn(agentEngine, "respond").mockRejectedValue(new Error("boom"));
    expect((await c.say("hi there")).text).toMatch(/technical difficulties/);
  });

  it("measures the webhook round trip for each turn", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const c = await phoneCall(biz, FROM, ["What are your hours?", "Do you have parking?"]);
    const call = (await Call.findById(c.call._id))!;
    expect(call.voice?.turns).toBe(2);
    expect(call.voice?.totalWebhookMs).toBeGreaterThan(0);
    expect(call.voice?.maxWebhookMs).toBeGreaterThanOrEqual((call.voice?.totalWebhookMs ?? 0) / 2);
  });

  it("keeps the current speech timing unless voice tuning is enabled, then validates the settings", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    process.env.VOICE_SPEECH_TIMEOUT = "2";
    process.env.VOICE_NO_INPUT_SECONDS = "8";
    expect(voiceTiming()).toEqual({ speechTimeout: "auto", noInputSeconds: 6 });
    expect((await phoneCall(biz)).first.text).toContain('speechTimeout="auto"');

    process.env.FEATURE_VOICE_TUNING = "true";
    expect(voiceTiming()).toEqual({ speechTimeout: 2, noInputSeconds: 8 });
    const tuned = await phoneCall(biz, "+15557002222");
    expect(tuned.first.text).toContain('speechTimeout="2"');
    expect(tuned.first.text).toContain('timeout="8"');

    process.env.VOICE_SPEECH_TIMEOUT = "99";
    process.env.VOICE_NO_INPUT_SECONDS = "x";
    expect(voiceTiming()).toEqual({ speechTimeout: "auto", noInputSeconds: 6 });
  });
});
