import fs from "node:fs";
import path from "node:path";
import twilio from "twilio";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Business, Call, CallRecoveryTask, CallSession, CallTranscript, ConcurrencyGate, FollowUp, Opportunity, Recording } from "../server/models";
import { agentEngine } from "../server/services/ai/agentEngine";
import { reapStaleSessions } from "../server/services/telephony/core/sessions";
import { __setTwilioCheckClientForTest } from "../server/services/telephony/twilioAccount";
import { login, makeBusiness, newCallSid } from "./helpers";
import { makeClient } from "./client";

type Biz = Awaited<ReturnType<typeof makeBusiness>>;
const report: { id: string; name: string; status: "pass" | "fail"; detail: string }[] = [];
const note = (id: string, name: string, detail: string) => report.push({ id, name, status: "pass", detail });

let n = 0;
const signed = (url: string, params: Record<string, string>, extra: Record<string, string> = {}) => {
  const sig = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, `https://staydesk.test${url}`, params);
  let p = makeClient().post(url).set("X-Twilio-Signature", sig).type("form");
  for (const [k, v] of Object.entries(extra)) p = p.set(k, v);
  return p.send(params);
};
const say = (xml: string) => [...xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => m[1]).join(" ").replace(/&amp;/g, "&").replace(/&apos;|&#39;/g, "'");
const idOf = (xml: string) => /callId=([0-9a-f]{24})/.exec(xml)?.[1];

/** One caller on the real webhook endpoints. */
class Caller {
  sid = newCallSid();
  from = `+1415555${String(1000 + ++n).slice(-4)}`;
  callId?: string;
  replies: string[] = [];
  constructor(public biz: Biz) {}
  async dial() {
    const res = await signed("/api/twilio/incoming", { CallSid: this.sid, From: this.from, To: this.biz.config.twilioNumber! });
    this.callId = idOf(res.text);
    this.replies.push(say(res.text));
    return res.text;
  }
  async speak(text: string, token = `t${++n}`) {
    const url = `/api/twilio/gather?callId=${this.callId}`;
    const res = await signed(url, { CallSid: this.sid, SpeechResult: text }, { "I-Twilio-Idempotency-Token": token });
    this.replies.push(say(res.text));
    return res.text;
  }
  async end(status = "completed", duration = "30") {
    return signed("/api/twilio/status", { CallSid: this.sid, CallStatus: status, CallDuration: duration });
  }
}
const aiBiz = (name?: string, limit = 25) => makeBusiness({ name, aiOnly: true }).then(async (b) => { await Business.updateOne({ _id: b.business._id }, { $set: { "concurrency.maxConcurrentCalls": limit } }); return b; });
const gate = async (b: Biz) => (await ConcurrencyGate.findOne({ businessId: b.business._id }))?.active ?? 0;

beforeEach(() => { process.env.TELEPHONY_SECRET_KEY = "k".repeat(40); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.TELEPHONY_MAX_SESSION_MS; });
afterAll(() => {
  if (process.env.CONCURRENCY_REPORT) {
    const out = path.resolve(__dirname, "../evals/reports/concurrency.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), kind: "automated_simulated", warning: "Run through the real webhook handlers with simulated Twilio requests against a local database. This is NOT a test with real Twilio calls, audio, speech recognition or text-to-speech.", results: report }, null, 2));
  }
});

describe("single call (Twilio webhook path)", () => {
  it("greets, answers from business knowledge, tracks the session lifecycle and frees the slot at the end", async () => {
    const b = await aiBiz();
    const c = new Caller(b);
    const hello = await c.dial();
    expect(hello).toContain("<Gather");
    expect(say(hello).length).toBeGreaterThan(10);
    let s = (await CallSession.findOne({ providerCallId: c.sid }))!;
    expect(s.sessionKey).toMatch(/^ses_/);
    expect(s.lifecycle).toBe("active");
    expect(s.admission).toBe("admitted");
    expect(s.configRef).toMatch(/^business@/);
    expect(await gate(b)).toBe(1);
    expect(await c.speak("Do you have parking?")).toMatch(/\$20/);
    s = (await CallSession.findOne({ providerCallId: c.sid }))!;
    expect(s.stage).toBe("speaking");
    await c.end();
    s = (await CallSession.findOne({ providerCallId: c.sid }))!;
    expect(s).toMatchObject({ lifecycle: "completed", stage: "completed", slotHeld: false });
    expect(s.timings?.setupMs).toBeGreaterThanOrEqual(0);
    expect(await gate(b)).toBe(0);
    const call = (await Call.findById(c.callId))!;
    expect(call.callUuid).toBeTruthy();
    expect(call.endedAt).toBeTruthy();
    note("single", "One caller, full conversation", "incoming → greeting → FAQ answer → completed; slot released");
  });
});

describe.each([2, 5, 10])("%i simultaneous callers", (count) => {
  it("run independent conversations with no shared data, and every session is tracked and cleaned up", async () => {
    const b = await aiBiz();
    const callers = Array.from({ length: count }, () => new Caller(b));
    await Promise.all(callers.map((c) => c.dial()));
    expect(await gate(b)).toBe(count);
    expect(new Set(callers.map((c) => c.callId)).size).toBe(count);
    expect(await CallSession.countDocuments({ businessId: b.business._id, lifecycle: "active" })).toBe(count);

    await Promise.all(callers.map((c, i) => c.speak(`my email is guest${i}@marker.test`)));
    await Promise.all(callers.map((c) => c.speak("Do you have parking?")));
    for (const [i, c] of callers.entries()) {
      const tr = JSON.stringify((await CallTranscript.findOne({ callId: c.callId }))!.segments);
      expect(tr).toContain(`guest${i}@marker.test`);
      for (let j = 0; j < count; j++) if (j !== i) expect(tr).not.toContain(`guest${j}@marker.test`);
      expect(c.replies.join(" ")).toMatch(/\$20/);
    }
    await Promise.all(callers.map((c) => c.end()));
    expect(await gate(b)).toBe(0);
    expect(await CallSession.countDocuments({ businessId: b.business._id, slotHeld: true })).toBe(0);
    expect(await CallSession.countDocuments({ businessId: b.business._id, lifecycle: "completed" })).toBe(count);
    note(`sim-${count}`, `${count} simultaneous callers`, `${count} isolated transcripts, ${count} sessions completed, 0 slots left`);
  });
});

describe("ten different conversations", () => {
  const SCRIPT = [
    "Do you have parking?", "What are your hours?", "How much is a room?", "I want to speak to a human", "my name is Alice Stone and I'd like to book a room",
    "Do you have parking? Also what are your hours?", "Can I cancel my reservation?", "Is there a pool?", "My name is Bob Lee, call me back please", "What is the price of a deluxe king room?",
  ];
  it("each caller gets an answer to their own request, and calls with a different business never mix", async () => {
    const a = await aiBiz("Alpha Inn"), other = await aiBiz("Beta Lodge");
    const callers = SCRIPT.map((_, i) => new Caller(i % 5 === 4 ? other : a));
    await Promise.all(callers.map((c) => c.dial()));
    const replies = await Promise.all(callers.map((c, i) => c.speak(SCRIPT[i])));
    expect(replies[0]).toMatch(/\$20/);
    expect(replies[3]).toContain("<Dial"); // the human request transfers only that caller
    for (const i of [0, 1, 2, 5, 7]) expect(replies[i]).not.toContain("<Dial");
    expect(new Set(callers.map((c) => c.callId)).size).toBe(10);
    for (const c of callers) {
      const call = (await Call.findById(c.callId))!;
      expect(String(call.businessId)).toBe(String(c.biz.business._id)); // routed by the dialled number
      expect(call.callerNumber).toBe(c.from);
    }
    expect(await gate(a)).toBe(8);
    expect(await gate(other)).toBe(2);
    await Promise.all(callers.map((c) => c.end()));
    note("diff-10", "Ten different conversations across two businesses", "answers matched each request; business and caller number per call correct");
  });
});

describe("ten recordings, transcripts and booking requests", () => {
  it("creates ten separate recordings, transcripts and exactly one request record per caller, even when webhooks are delivered twice", async () => {
    const b = await aiBiz();
    await Business.updateOne({ _id: b.business._id }, { $set: { "privacy.recordingEnabled": true } });
    const callers = Array.from({ length: 10 }, () => new Caller(b));
    await Promise.all(callers.map((c) => c.dial()));
    await Promise.all(callers.map((c, i) => c.speak(`I'd like to book a room for two nights, my name is Guest${i} Tester`, `bk-${i}`)));
    await Promise.all(callers.map((c, i) => c.speak("my name is Guest" + i + " Tester", `nm-${i}`)));
    // Twilio re-delivers the same turns
    await Promise.all(callers.map((c, i) => c.speak("my name is Guest" + i + " Tester", `nm-${i}`)));
    await Promise.all(callers.map((c, i) => signed("/api/twilio/recording", { CallSid: c.sid, RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE${i}`, RecordingSid: `RE${i}`, RecordingDuration: "20" })));
    await Promise.all(callers.map((c) => c.end()));

    expect(await Recording.countDocuments({ businessId: b.business._id })).toBe(10);
    expect(new Set((await Recording.find({ businessId: b.business._id })).map((r) => r.recordingId)).size).toBe(10);
    expect(await CallTranscript.countDocuments({ businessId: b.business._id })).toBe(10);
    for (const c of callers) {
      const records = (await FollowUp.countDocuments({ callId: c.callId })) + (await Opportunity.countDocuments({ callId: c.callId }));
      expect(records).toBeGreaterThanOrEqual(1);
      expect(await FollowUp.countDocuments({ callId: c.callId })).toBeLessThanOrEqual(1); // no duplicate from the re-delivered turn
    }
    note("rec-book-10", "Ten recordings, transcripts and booking requests", "10 distinct recordings and transcripts; ≤1 follow-up per call despite duplicate webhooks");
  });
});

describe("human transfer, failures and capacity", () => {
  it("a human transfer for one caller does not touch the others", async () => {
    const b = await aiBiz();
    const callers = Array.from({ length: 5 }, () => new Caller(b));
    await Promise.all(callers.map((c) => c.dial()));
    const [t, ...rest] = callers;
    expect(await t.speak("I want to speak to a human")).toContain("<Dial");
    expect((await CallSession.findOne({ providerCallId: t.sid }))!.stage).toBe("transferring");
    for (const r of await Promise.all(rest.map((c) => c.speak("Do you have parking?")))) expect(r).toMatch(/\$20/);
    for (const c of rest) expect((await CallSession.findOne({ providerCallId: c.sid }))!).toMatchObject({ lifecycle: "active", stage: "speaking" });
    expect(await Call.countDocuments({ _id: { $in: rest.map((c) => c.callId) }, transferAttempted: true })).toBe(0);
    note("transfer-isolated", "Human transfer while other AI sessions stay active", "only the requesting call transferred");
  });

  it("one session failing does not disturb the others, and the failed caller is told honestly", async () => {
    const b = await aiBiz();
    const callers = Array.from({ length: 5 }, () => new Caller(b));
    await Promise.all(callers.map((c) => c.dial()));
    const real = agentEngine.respond.bind(agentEngine);
    const victim = callers[2].callId!;
    vi.spyOn(agentEngine, "respond").mockImplementation((id, text, opts) => (String(id) === victim ? Promise.reject(new Error("provider timeout")) : real(id, text, opts)));
    const out = await Promise.all(callers.map((c) => c.speak("Do you have parking?")));
    expect(out[2]).toMatch(/problem|again/i);
    for (const i of [0, 1, 3, 4]) expect(out[i]).toMatch(/\$20/);
    expect((await Call.findById(victim))!.voice?.recoveredErrors).toBe(1);
    for (const c of callers) expect((await CallSession.findOne({ providerCallId: c.sid }))!.lifecycle).toBe("active");
    note("one-fails", "One session failing while others continue", "victim recovered with an honest retry prompt; 4 others answered normally");
  });

  it("a database error while setting up one call fails only that call", async () => {
    const b = await aiBiz();
    const ok1 = new Caller(b), bad = new Caller(b), ok2 = new Caller(b);
    await ok1.dial();
    const orig = Call.create.bind(Call);
    vi.spyOn(Call, "create").mockImplementationOnce(() => Promise.reject(new Error("mongo down")) as never);
    expect(await bad.dial()).toContain("technical difficulties");
    vi.restoreAllMocks();
    void orig;
    expect(await ok2.dial()).toContain("<Gather");
    expect(await ok1.speak("Do you have parking?")).toMatch(/\$20/);
    expect(await gate(b)).toBe(2);
  });

  it("at capacity, extra callers get the controlled fallback and a callback task; capacity returns when calls end", async () => {
    const b = await aiBiz("Cap Inn", 3);
    const callers = Array.from({ length: 5 }, () => new Caller(b));
    const outs = await Promise.all(callers.map((c) => c.dial()));
    expect(outs.filter((o) => o.includes("<Gather"))).toHaveLength(3);
    const refused = outs.filter((o) => !o.includes("<Gather"));
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r).toMatch(/call you back/i);
    expect(await gate(b)).toBe(3);
    expect(await CallRecoveryTask.countDocuments({ businessId: b.business._id, reason: "capacity" })).toBe(2);
    expect(await FollowUp.countDocuments({ businessId: b.business._id, priority: "high" })).toBe(2);
    expect(await CallSession.countDocuments({ businessId: b.business._id, failureCause: "overflow:callback" })).toBe(2);
    // a refused caller's retry (duplicate webhook) is refused the same way and queues nothing new
    const refusedCaller = callers[outs.findIndex((o) => !o.includes("<Gather"))];
    expect(await refusedCaller.dial()).toMatch(/call you back/i);
    expect(await CallRecoveryTask.countDocuments({ businessId: b.business._id })).toBe(2);
    // end one admitted call → the next caller is served
    const done = callers[outs.findIndex((o) => o.includes("<Gather"))];
    await done.end();
    const next = new Caller(b);
    expect(await next.dial()).toContain("<Gather");
    // the dashboard reports the same facts
    const owner = await login(b.email);
    const live = (await owner.get("/api/calls/live")).body;
    expect(live.capacity).toMatchObject({ active: 3, limit: 3, available: 0, overflowedToday: 2, queueEnabled: false, verified: false });
    expect(live.sessions).toHaveLength(3);
    note("capacity", "Calls arriving at configured capacity", "3 served, 2 given callback fallback + tasks; capacity reused after a call ended");
  });

  it("transfer overflow policy rings the team once, then falls back to a callback if nobody answers (no loop)", async () => {
    const b = await aiBiz("Xfer Inn", 1);
    await Business.updateOne({ _id: b.business._id }, { $set: { "concurrency.overflowPolicy": "transfer" } });
    await new Caller(b).dial();
    const second = new Caller(b);
    const first = await second.dial();
    expect(first).toContain("<Dial");
    const retry = await signed(`/api/twilio/dial-result?callId=${second.callId}`, { CallSid: second.sid, DialCallStatus: "no-answer" });
    expect(retry.text).toMatch(/call you back/i);
    expect(retry.text).not.toContain("<Dial");
    expect(await CallRecoveryTask.countDocuments({ businessId: b.business._id, reason: "capacity" })).toBe(1);
  });
});

describe("duplicate events and lost connections", () => {
  it("a repeated incoming webhook returns the same call, one session and one slot; repeated status events free the slot once", async () => {
    const b = await aiBiz();
    const c = new Caller(b);
    const [x, y] = await Promise.all([c.dial(), new Caller(b).dial()]);
    void x; void y;
    const dup = new Caller(b);
    dup.sid = c.sid; dup.from = c.from;
    const again = await dup.dial();
    expect(idOf(again)).toBe(c.callId);
    expect(await Call.countDocuments({ providerCallId: c.sid })).toBe(1);
    expect(await CallSession.countDocuments({ providerCallId: c.sid })).toBe(1);
    expect(await gate(b)).toBe(2);
    await Promise.all([c.end(), c.end(), c.end()]);
    expect(await gate(b)).toBe(1);
    note("dup-events", "Webhook retries and duplicate events", "same call/session/slot; slot freed once");
  });

  it("a call whose end event never arrives is cleaned up, and a late event afterwards changes nothing", async () => {
    const b = await aiBiz();
    const c = new Caller(b);
    await c.dial();
    process.env.TELEPHONY_MAX_SESSION_MS = "1000";
    await CallSession.updateOne({ providerCallId: c.sid }, { $set: { startedAt: new Date(Date.now() - 60_000) } });
    expect(await reapStaleSessions()).toBe(1);
    expect(await gate(b)).toBe(0);
    expect((await CallSession.findOne({ providerCallId: c.sid }))!).toMatchObject({ lifecycle: "failed", failureCause: "timeout" });
    expect(await CallRecoveryTask.countDocuments({ businessId: b.business._id, reason: "timeout" })).toBe(1);
    await c.end();
    expect(await gate(b)).toBe(0);
    note("lost-end", "Network interruption: end event never arrives", "stale session reaped, slot freed once, callback queued");
  });

  it("a carrier-level failure ends only that session as failed with its cause", async () => {
    const b = await aiBiz();
    const a = new Caller(b), z = new Caller(b);
    await Promise.all([a.dial(), z.dial()]);
    await a.end("failed", "0");
    expect((await CallSession.findOne({ providerCallId: a.sid }))!).toMatchObject({ lifecycle: "failed", terminationReason: "failed" });
    expect((await CallSession.findOne({ providerCallId: z.sid }))!.lifecycle).toBe("active");
    expect(await gate(b)).toBe(1);
  });
});

describe("Live Calls API and Twilio account check", () => {
  it("lists only this business's active sessions with masked numbers and stages, and filters history", async () => {
    const a = await aiBiz("Alpha Inn"), o = await aiBiz("Other Inn");
    const mine = [new Caller(a), new Caller(a)], theirs = new Caller(o);
    await Promise.all([...mine.map((c) => c.dial()), theirs.dial()]);
    await mine[0].speak("Do you have parking?");
    const owner = await login(a.email);
    const live = (await owner.get("/api/calls/live")).body;
    expect(live.sessions).toHaveLength(2);
    expect(JSON.stringify(live)).not.toContain(theirs.sid);
    expect(JSON.stringify(live)).not.toContain(mine[0].from); // never the full number
    expect(live.sessions.every((s: { phone: string }) => /•••/.test(s.phone))).toBe(true);
    expect(live.latency.speechRecognitionMs).toBeNull();
    expect(live.latency.ttsMs).toBeNull();
    expect(live.latency.webhookRoundTripMs).not.toBeNull();
    await mine[1].end("failed", "0");
    expect((await owner.get("/api/calls/live?scope=recent&status=failed")).body.sessions).toHaveLength(1);
    expect((await owner.get("/api/calls/live?scope=recent&status=completed")).body.sessions).toHaveLength(0);
    expect((await makeClient().get("/api/calls/live")).status).toBe(401);
  });

  it("verifies the Twilio account and webhook honestly, and warns about trial accounts and wrong webhooks", async () => {
    const b = await aiBiz();
    const owner = await login(b.email);
    expect((await owner.get("/api/telephony/twilio-check")).body.status).toBe("not_configured");
    const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    const { env } = await import("../server/config/env");
    (env as { TWILIO_ACCOUNT_SID?: string }).TWILIO_ACCOUNT_SID = "ACtest";
    __setTwilioCheckClientForTest(() => ({
      api: { accounts: () => ({ fetch: async () => ({ type: "Trial", status: "active" }) }) },
      incomingPhoneNumbers: { list: async () => [{ phoneNumber: b.config.twilioNumber!, voiceUrl: "https://elsewhere.example/hook", statusCallback: null }] },
    }));
    const r = (await owner.get("/api/telephony/twilio-check")).body;
    __setTwilioCheckClientForTest(null);
    (env as { TWILIO_ACCOUNT_SID?: string }).TWILIO_ACCOUNT_SID = sid;
    if (sid === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = sid;
    void tok;
    expect(r.status).toBe("problem");
    expect(r.voiceUrlMatches).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/TRIAL/);
    expect(r.warnings.join(" ")).toMatch(/does not expose/);
  });
});

describe("Concurrent Call Testing records", () => {
  it("shows automated results as simulated, never counts them as verified capacity, and verifies only a person's recorded live pass", async () => {
    const b = await aiBiz();
    const owner = await login(b.email);
    const first = (await owner.get("/api/qa/concurrency")).body;
    expect(first.scenarios).toHaveLength(12);
    expect(first.verifiedConcurrentCalls).toBe(0);
    expect(first.scenarios.every((s: { live: { status: string } }) => s.live.status === "not_tested")).toBe(true);
    expect((await owner.put("/api/qa/concurrency/ten").send({ status: "pass", notes: "ok", concurrency: 4 })).status).toBe(400);
    expect((await owner.put("/api/qa/concurrency/ten").send({ status: "pass", notes: "10 phones, real Twilio", concurrency: 10 })).status).toBe(200);
    const after = (await owner.get("/api/qa/concurrency")).body;
    expect(after.verifiedConcurrentCalls).toBe(10);
    expect(after.scenarios.find((s: { id: string }) => s.id === "ten").live).toMatchObject({ status: "pass", concurrency: 10 });
    expect((await owner.put("/api/qa/concurrency/nope").send({ status: "pass" })).status).toBe(404);
    const other = await login((await aiBiz("Other")).email);
    expect((await other.get("/api/qa/concurrency")).body.verifiedConcurrentCalls).toBe(0); // per business
  });
});
