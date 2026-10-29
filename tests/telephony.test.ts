import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Business, BusinessPhoneNumber, Call, CallRecoveryTask, CallSession, FollowUp, Notification, OutboundCallRequest, OutboundConsent, Reservation, SipTrunk, SuppressionEntry, TelephonyConnection, TelephonyHealthEvent,
} from "../server/models";
import { __setSipFetchForTest, signPayload, verifySignature, controlUrlProblem } from "../server/services/telephony/core/adapters/sipGateway";
import { __setTwilioRestForTest } from "../server/services/telephony/core/adapters/twilio";
import { __setVapiFetchForTest } from "../server/services/telephony/core/adapters/vapi";
import { CircuitBreakers, breakers, runWithFailover } from "../server/services/telephony/core/breaker";
import { checkConnection, effectiveStatus } from "../server/services/telephony/core/health";
import { addNumber, resolveBusinessByDid, verifyNumber } from "../server/services/telephony/core/numbers";
import { findBusinessByNumber } from "../server/services/business/businessService";
import { evaluateOutbound, localMinutes, withinCallingHours } from "../server/services/outbound/policy";
import { dispatchDue, requestOutbound } from "../server/services/outbound/service";
import { decryptSecret, encryptSecret } from "../server/utils/secrets";
import { login, makeBusiness, request, twilioPost } from "./helpers";
import { makeClient } from "./client";

const SECRET_KEY = "k".repeat(40);
const GATEWAY_SECRET = "g".repeat(40);
const ENV = ["FEATURE_TELEPHONY_CORE", "FEATURE_SIP_GATEWAY", "FEATURE_OUTBOUND_CALLING", "TELEPHONY_SECRET_KEY", "CRON_SECRET", "TWILIO_PHONE_NUMBER"];

// A fixed "now": noon in New York (17:00 UTC, winter) and the middle of the night.
const NOON = new Date("2027-03-10T17:00:00Z");
const NIGHT = new Date("2027-03-10T09:00:00Z");

beforeEach(() => {
  process.env.TELEPHONY_SECRET_KEY = SECRET_KEY;
  process.env.FEATURE_TELEPHONY_CORE = "true";
  process.env.FEATURE_SIP_GATEWAY = "true";
  process.env.FEATURE_OUTBOUND_CALLING = "true";
  breakers.reset();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  __setSipFetchForTest(null);
  __setTwilioRestForTest(null);
  __setVapiFetchForTest(null);
});

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

async function saveSipConnection(biz: Awaited<ReturnType<typeof makeBusiness>>, controlUrl = "https://gw.example.test") {
  const owner = await login(biz.email);
  const res = await owner.post("/api/telephony/connections").send({ kind: "sip_gateway", settings: { controlUrl }, secrets: { controlSecret: GATEWAY_SECRET } });
  expect(res.status).toBe(201);
  return { owner, id: res.body.id as string };
}

async function verifiedNumber(biz: Awaited<ReturnType<typeof makeBusiness>>, e164: string, role: "inbound" | "both" = "inbound") {
  await BusinessPhoneNumber.create({ businessId: biz.business._id, e164, role, mode: "forwarding", verification: { status: "verified", verifiedAt: new Date() }, callerIdAuthorized: role !== "inbound" });
}

// ------------------------------------------------------------------------------------------------------------------
describe("secrets", () => {
  it("round-trips, detects tampering, and refuses to work without a key", () => {
    const c = encryptSecret("super-secret-token");
    expect(c).not.toContain("super-secret");
    expect(decryptSecret(c)).toBe("super-secret-token");
    expect(encryptSecret("super-secret-token")).not.toBe(c); // fresh IV every time
    const parts = c.split(".");
    expect(() => decryptSecret([parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64")].join("."))).toThrow();
    delete process.env.TELEPHONY_SECRET_KEY;
    expect(() => encryptSecret("x")).toThrow(/TELEPHONY_SECRET_KEY/);
  });

  it("stores credentials encrypted and never returns them", async () => {
    const biz = await makeBusiness();
    const { owner } = await saveSipConnection(biz);
    const stored = (await TelephonyConnection.findOne({ businessId: biz.business._id }))!;
    const raw = JSON.stringify(stored.toObject());
    expect(raw).not.toContain(GATEWAY_SECRET);
    const overview = await owner.get("/api/telephony");
    expect(JSON.stringify(overview.body)).not.toContain(GATEWAY_SECRET);
    expect(JSON.stringify(overview.body)).not.toContain("cipher");
    expect(overview.body.connections[0].secrets.controlSecret).toBe("••••gggg");
  });

  it("refuses to store credentials when the server has no key", async () => {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    delete process.env.TELEPHONY_SECRET_KEY;
    const res = await owner.post("/api/telephony/connections").send({ kind: "vapi", settings: {}, secrets: { apiKey: "abc" } });
    expect(res.status).toBe(400);
    expect(await TelephonyConnection.countDocuments()).toBe(0);
  });
});

describe("permissions and the feature flag", () => {
  it("is closed when the flag is off, and owner/admin only when on", async () => {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    process.env.FEATURE_TELEPHONY_CORE = "false";
    expect((await owner.get("/api/telephony")).body).toMatchObject({ enabled: false });
    expect((await owner.post("/api/telephony/numbers").send({ number: "+14155550100" })).status).toBe(404);
    process.env.FEATURE_TELEPHONY_CORE = "true";
    expect((await request().get("/api/telephony")).status).toBe(401);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("provider health and status", () => {
  it("not configured → connected → degraded → offline (with an alert), per the real checks", async () => {
    const biz = await makeBusiness();
    expect((await checkConnection(biz.business._id, "sip_gateway")).status).toBe("not_configured");

    const { id } = await saveSipConnection(biz);
    expect((await TelephonyConnection.findById(id))!.status).toBe("testing");

    __setSipFetchForTest((async () => ok()) as never);
    expect((await checkConnection(biz.business._id, "sip_gateway")).status).toBe("connected");

    __setSipFetchForTest((async () => new Response("", { status: 503 })) as never);
    expect((await checkConnection(biz.business._id, "sip_gateway")).status).toBe("degraded");
    await checkConnection(biz.business._id, "sip_gateway");
    const third = await checkConnection(biz.business._id, "sip_gateway");
    expect(third.status).toBe("offline");
    expect(await TelephonyHealthEvent.countDocuments({ provider: "sip_gateway", kind: "alert" })).toBe(1);
    expect(await Notification.countDocuments({ businessId: biz.business._id, title: /offline/i })).toBe(1);
    await checkConnection(biz.business._id, "sip_gateway"); // still offline: no second alert
    expect(await TelephonyHealthEvent.countDocuments({ provider: "sip_gateway", kind: "alert" })).toBe(1);
  });

  it("invalid configuration is reported, not tested (plain-HTTP gateway URL, short secret)", async () => {
    expect(controlUrlProblem("http://gw.example.test")).toMatch(/HTTPS/);
    expect(controlUrlProblem("https://user:pw@gw.example.test")).toMatch(/credentials/);
    expect(controlUrlProblem("http://localhost:8080")).toBeNull();
    const biz = await makeBusiness();
    await saveSipConnection(biz, "http://gw.example.test");
    const r = await checkConnection(biz.business._id, "sip_gateway");
    expect(r.status).toBe("not_configured");
    expect(r.reason).toMatch(/HTTPS/);
  });

  it("a timeout counts as a failure", async () => {
    const biz = await makeBusiness();
    await saveSipConnection(biz);
    __setSipFetchForTest(((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as never);
    const t0 = Date.now();
    const r = await checkConnection(biz.business._id, "sip_gateway");
    expect(r.status).toBe("degraded");
    expect(r.reason).toMatch(/timed out/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900);
  }, 15000);

  it("Twilio and Vapi adapters validate before touching the network", async () => {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    await owner.post("/api/telephony/connections").send({ kind: "twilio", settings: {}, secrets: { accountSid: "nope", authToken: "x" } });
    expect((await checkConnection(biz.business._id, "twilio")).reason).toMatch(/SID/);
    await owner.post("/api/telephony/connections").send({ kind: "vapi", settings: {}, secrets: { apiKey: "key" } });
    expect((await checkConnection(biz.business._id, "vapi")).reason).toMatch(/assistant id/);

    let called = 0;
    __setVapiFetchForTest((async () => { called++; return ok({}); }) as never);
    await owner.post("/api/telephony/connections").send({ kind: "vapi", settings: { assistantId: "a", phoneNumberId: "p" }, secrets: { apiKey: "key" } });
    expect((await checkConnection(biz.business._id, "vapi")).status).toBe("connected");
    expect(called).toBe(1);

    const sid = "AC" + "a".repeat(32);
    __setTwilioRestForTest((() => ({ api: { accounts: () => ({ fetch: async () => ({}) }) } })) as never);
    await owner.post("/api/telephony/connections").send({ kind: "twilio", settings: {}, secrets: { accountSid: sid, authToken: "tok" } });
    expect((await checkConnection(biz.business._id, "twilio")).status).toBe("connected");
  });

  it("the direct LiveKit adapter says it is not implemented", async () => {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    await owner.post("/api/telephony/connections").send({ kind: "livekit", settings: {}, secrets: {} });
    const r = await checkConnection(biz.business._id, "livekit");
    expect(r.status).toBe("not_configured");
    expect(r.reason).toMatch(/not implemented/i);
  });

  it("a stale 'connected' is not shown as current", () => {
    const old = new Date(Date.now() - 10 * 60_000);
    expect(effectiveStatus({ status: "connected", lastCheckedAt: old }).status).toBe("degraded");
    expect(effectiveStatus({ status: "connected", lastCheckedAt: new Date() }).status).toBe("connected");
  });
});

describe("circuit breaker and failover", () => {
  it("opens after repeated failures, allows one trial after the cooldown, and closes on success", () => {
    let t = 0;
    const changes: string[] = [];
    const b = new CircuitBreakers(3, 1000, () => t, (p, s) => changes.push(`${p}:${s}`));
    for (let i = 0; i < 3; i++) b.failure("x");
    expect(b.state("x")).toBe("open");
    expect(() => b.assertCallable("x")).toThrow(/temporarily disabled/);
    t = 1500;
    expect(b.state("x")).toBe("half_open");
    b.assertCallable("x"); // the trial
    expect(() => b.assertCallable("x")).toThrow(); // only one trial at a time
    b.success("x");
    expect(b.state("x")).toBe("closed");
    expect(changes).toEqual(["x:open", "x:closed"]);
    b.failure("x"); b.failure("x");
    expect(b.state("x")).toBe("closed"); // counter was reset
  });

  it("uses providers in priority order, skips open circuits, and reports who served the request", async () => {
    const b = new CircuitBreakers(1, 60_000);
    const calls: string[] = [];
    const fn = async (p: string) => { calls.push(p); if (p !== "c") throw new Error(`${p} down`); return "done"; };
    const r1 = await runWithFailover(["a", "b", "c"], fn, b);
    expect(r1).toMatchObject({ provider: "c", value: "done" });
    expect(r1.failed.map((f) => f.provider)).toEqual(["a", "b"]);
    calls.length = 0;
    const r2 = await runWithFailover(["a", "b", "c"], fn, b); // a and b are open now: not even tried
    expect(calls).toEqual(["c"]);
    expect(r2.skipped).toEqual(["a", "b"]);
    await expect(runWithFailover(["a", "b"], fn, b)).rejects.toThrow(/No provider could handle/);
    await expect(runWithFailover([], fn, b)).rejects.toThrow(/none configured/);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("number onboarding and mapping", () => {
  it("an unverified number routes nowhere; verification needs the right code; mapping is per business", async () => {
    const a = await makeBusiness({ name: "Hotel A" });
    const b = await makeBusiness({ name: "Hotel B" });
    process.env.TWILIO_PHONE_NUMBER = "+15550009999";
    const add = await addNumber({ businessId: a.business._id, number: "(415) 555-0101", mode: "forwarding" });
    expect(add.delivery).toBe("skipped"); // no SMS provider in tests; nothing pretends it was sent
    const stored = (await BusinessPhoneNumber.findById(add.id))!;
    expect(stored.e164).toBe("+14155550101");
    expect(stored.verification!.codeHash).toMatch(/^[a-f0-9]{64}$/); // only a hash is stored

    expect(await resolveBusinessByDid("+14155550101")).toBeNull();
    expect(await verifyNumber(a.business._id, add.id, "000000")).toBe(false);
    await expect(verifyNumber(b.business._id, add.id, "000000")).rejects.toThrow(/not found/i); // another tenant cannot touch it

    // Learn the real code by brute force the way an attacker could NOT (attempts are limited): set a known hash instead.
    const crypto = await import("node:crypto");
    await BusinessPhoneNumber.updateOne({ _id: add.id }, { "verification.codeHash": crypto.createHash("sha256").update("123456").digest("hex") });
    expect(await verifyNumber(a.business._id, add.id, "123456")).toBe(true);

    await verifiedNumber(b, "+14155550102");
    expect((await resolveBusinessByDid("+14155550101"))!.business.name).toBe("Hotel A");
    expect((await resolveBusinessByDid("+14155550102"))!.business.name).toBe("Hotel B");
    expect(await resolveBusinessByDid("+14155550103")).toBeNull();
  });

  it("limits guesses and expires codes", async () => {
    const a = await makeBusiness();
    const add = await addNumber({ businessId: a.business._id, number: "+14155550111", mode: "forwarding" });
    for (let i = 0; i < 5; i++) expect(await verifyNumber(a.business._id, add.id, "000000")).toBe(false);
    await expect(verifyNumber(a.business._id, add.id, "000000")).rejects.toThrow(/Too many/);
    const b = await makeBusiness();
    const add2 = await addNumber({ businessId: b.business._id, number: "+14155550112", mode: "forwarding" });
    await BusinessPhoneNumber.updateOne({ _id: add2.id }, { "verification.expiresAt": new Date(Date.now() - 1000) });
    await expect(verifyNumber(b.business._id, add2.id, "123456")).rejects.toThrow(/expired/);
  });

  it("one number can never belong to two accounts, and the message does not say which", async () => {
    const a = await makeBusiness({ twilioNumber: "+14155550120" });
    const b = await makeBusiness();
    await expect(addNumber({ businessId: b.business._id, number: "+14155550120", mode: "provider_number" })).rejects.toThrow(/already connected to an account/);
    await addNumber({ businessId: a.business._id, number: "+14155550121", mode: "forwarding" });
    await expect(addNumber({ businessId: b.business._id, number: "+14155550121", mode: "forwarding" })).rejects.toThrow(/already connected to an account/);
    await expect(addNumber({ businessId: b.business._id, number: "123", mode: "forwarding" })).rejects.toThrow(/country code/);
  });

  it("existing Twilio routing is untouched, and verified numbers join it only when the core is on", async () => {
    const legacy = await makeBusiness({ twilioNumber: "+14155550130" });
    const newer = await makeBusiness();
    await verifiedNumber(newer, "+14155550131");
    expect((await findBusinessByNumber("+14155550130"))!.business._id).toEqual(legacy.business._id);
    expect((await findBusinessByNumber("+14155550131"))!.business._id).toEqual(newer.business._id);
    process.env.FEATURE_TELEPHONY_CORE = "false";
    expect(await findBusinessByNumber("+14155550131")).toBeNull();
    expect((await findBusinessByNumber("+14155550130"))!.business._id).toEqual(legacy.business._id);
  });
});

// ------------------------------------------------------------------------------------------------------------------
function signedPost(connectionId: string, payload: unknown, opts: { secret?: string; ts?: number; conn?: string; body?: string } = {}) {
  const body = opts.body ?? JSON.stringify(payload);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return makeClient()
    .post("/api/telephony/sip/events")
    .set("x-staydesk-connection", opts.conn ?? connectionId)
    .set("x-staydesk-timestamp", String(ts))
    .set("x-staydesk-signature", signPayload(opts.secret ?? GATEWAY_SECRET, ts, body))
    .send(payload);
}

describe("SIP gateway events", () => {
  async function setup() {
    const biz = await makeBusiness({ name: "Gateway Hotel" });
    const { id } = await saveSipConnection(biz);
    await verifiedNumber(biz, "+14155550140");
    return { biz, id };
  }
  const incoming = (n: number | string, to = "+14155550140") => ({ events: [{ type: "incoming", providerCallId: `sip-${n}`, from: "+13105550100", to }] });

  it("rejects bad signatures, wrong connections, stale timestamps and a closed feature flag", async () => {
    const { id } = await setup();
    expect((await signedPost(id, incoming(1), { secret: "x".repeat(40) })).status).toBe(401);
    expect((await signedPost(id, incoming(1), { conn: "0".repeat(24) })).status).toBe(401);
    expect((await signedPost(id, incoming(1), { conn: "not-an-id" })).status).toBe(401);
    expect((await signedPost(id, incoming(1), { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401); // replay
    expect(await Call.countDocuments()).toBe(0);
    expect(verifySignature(GATEWAY_SECRET, "abc", "x", "{}")).toBe(false);
    process.env.FEATURE_SIP_GATEWAY = "false";
    expect((await signedPost(id, incoming(1))).status).toBe(404);
  });

  it("routes an inbound call to the right business exactly once, even if the event repeats", async () => {
    const { biz, id } = await setup();
    const r1 = await signedPost(id, incoming(1));
    expect(r1.status).toBe(200);
    expect(r1.body.decisions[0]).toMatchObject({ action: "answer", businessId: String(biz.business._id) });
    const r2 = await signedPost(id, incoming(1));
    expect(r2.body.decisions[0].callId).toBe(r1.body.decisions[0].callId);
    expect(await Call.countDocuments()).toBe(1);
    expect(await CallSession.countDocuments()).toBe(1);
    expect((await Call.findOne())!).toMatchObject({ provider: "sip", direction: "inbound" });
  });

  it("never delivers another business's number or an unknown one", async () => {
    const { id } = await setup();
    const other = await makeBusiness({ name: "Other Hotel" });
    await verifiedNumber(other, "+14155550141");
    expect((await signedPost(id, incoming(2, "+14155550141"))).body.decisions[0]).toMatchObject({ action: "reject", reason: "wrong_account" });
    expect((await signedPost(id, incoming(3, "+14155559999"))).body.decisions[0]).toMatchObject({ action: "reject", reason: "unknown_number" });
    expect(await Call.countDocuments()).toBe(0);
  });

  it("handles many simultaneous calls and enforces the concurrency limit, capturing a callback for rejected ones", async () => {
    const { biz, id } = await setup();
    await SipTrunk.create({ businessId: biz.business._id, name: "main", host: "sip.carrier.test", maxConcurrentCalls: 3, allowedIps: ["203.0.113.10"] });
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => signedPost(id, incoming(`par${n}`))));
    const decisions = results.map((r) => r.body.decisions[0]);
    // Parallel requests race on the count, so assert the guarantees that must hold regardless of interleaving:
    expect(decisions.filter((d) => d.action === "answer").length).toBeGreaterThanOrEqual(3);
    expect(new Set(decisions.filter((d) => d.action === "answer").map((d) => d.callId)).size).toBe(decisions.filter((d) => d.action === "answer").length);
    expect(await CallSession.countDocuments()).toBe(decisions.filter((d) => d.action === "answer").length);
    // Sequential calls beyond the limit are rejected for sure.
    await CallSession.deleteMany({});
    await Call.deleteMany({});
    for (const n of [1, 2, 3]) expect((await signedPost(id, incoming(`seq${n}`))).body.decisions[0].action).toBe("answer");
    const fourth = await signedPost(id, incoming("seq4"));
    expect(fourth.body.decisions[0]).toMatchObject({ action: "reject", reason: "capacity" });
    expect(await CallRecoveryTask.countDocuments({ reason: "capacity" })).toBe(1);
    expect(await FollowUp.countDocuments({ businessId: biz.business._id, priority: "high" })).toBe(1);
    await signedPost(id, incoming("seq4")); // retried rejection: still one task
    expect(await CallRecoveryTask.countDocuments({ reason: "capacity" })).toBe(1);
  });

  it("tracks call state, hang-up reasons, quality, latency; masks keypad digits; closes the call once", async () => {
    const { biz, id } = await setup();
    const callId = (await signedPost(id, incoming("life"))).body.decisions[0].callId as string;
    const ev = (e: object) => signedPost(id, { events: [{ providerCallId: "sip-life", ...e }] });
    await ev({ type: "status", status: "answered" });
    await ev({ type: "dtmf", digits: "4" });
    await ev({ type: "dtmf", digits: "4111111111111111" });
    await ev({ type: "quality", jitterMs: 12, packetLossPct: 0.4, rttMs: 80, mos: 4.2 });
    await ev({ type: "latency", turnMs: 700 });
    await ev({ type: "latency", turnMs: 900 });
    const mid = (await CallSession.findOne({ providerCallId: "sip-life" }))!;
    expect(mid.status).toBe("answered");
    expect(mid.dtmf).toEqual(["4", "•".repeat(16)]);
    expect(JSON.stringify(mid.toObject())).not.toContain("4111");
    expect(mid.quality).toMatchObject({ jitterMs: 12, mos: 4.2 });
    expect(mid.latency).toMatchObject({ turns: 2, totalMs: 1600, maxMs: 900 });

    await ev({ type: "status", status: "completed", reason: "caller_hangup", durationSeconds: 61 });
    await ev({ type: "status", status: "completed", reason: "caller_hangup", durationSeconds: 61 }); // duplicate delivery
    const done = (await CallSession.findOne({ providerCallId: "sip-life" }))!;
    expect(done).toMatchObject({ status: "completed", terminationReason: "caller_hangup", durationSeconds: 61 });
    expect((await Call.findById(callId))!.endedAt).toBeTruthy();
    expect(await CallRecoveryTask.countDocuments()).toBe(0); // the caller hung up: nothing was lost

    const overview = await (await login(biz.email)).get("/api/telephony");
    expect(overview.body.quality).toMatchObject({ latencyMeasuredCalls: 1, avgTurnLatencyMs: 800, maxTurnLatencyMs: 900, avgMos: 4.2 });
  });

  it("a call lost to our own infrastructure creates one callback task, however often it is reported", async () => {
    const { biz, id } = await setup();
    await signedPost(id, incoming("lost"));
    const lost = { events: [{ type: "status", providerCallId: "sip-lost", status: "failed", reason: "worker_unavailable" }] };
    await signedPost(id, lost);
    await signedPost(id, lost);
    expect(await CallRecoveryTask.countDocuments({ businessId: biz.business._id, reason: "worker_unavailable" })).toBe(1);
    expect(await FollowUp.countDocuments({ businessId: biz.business._id, priority: "high" })).toBe(1);
    expect(await Notification.countDocuments({ businessId: biz.business._id, title: /lost/i })).toBe(1);
  });

  it("events for unknown calls or another tenant's calls change nothing; heartbeats mark the gateway connected", async () => {
    const { id } = await setup();
    const other = await makeBusiness();
    const { id: otherConn } = await saveSipConnection(other);
    await verifiedNumber(other, "+14155550150");
    await signedPost(otherConn, incoming("theirs", "+14155550150"));
    await signedPost(id, { events: [{ type: "status", providerCallId: "sip-theirs", status: "failed", reason: "media_failure" }] });
    expect((await CallSession.findOne({ providerCallId: "sip-theirs" }))!.status).toBe("ringing");
    expect(await CallRecoveryTask.countDocuments()).toBe(0);

    await signedPost(id, { events: [{ type: "heartbeat", activeCalls: 2 }] });
    expect((await TelephonyConnection.findById(id))!.status).toBe("connected");
  });
});

// ------------------------------------------------------------------------------------------------------------------
async function outboundBiz(over: Partial<{ enabled: boolean; purposes: string[]; windowStart: string; windowEnd: string; maxAttempts: number; callerId: string }> = {}) {
  const biz = await makeBusiness({ name: "Outbound Hotel" });
  await Business.updateOne({ _id: biz.business._id }, { $set: { "outbound.enabled": over.enabled ?? true, "outbound.purposes": over.purposes ?? ["reservation_reminder", "customer_callback", "approved_follow_up", "order_status"], "outbound.windowStart": over.windowStart ?? "09:00", "outbound.windowEnd": over.windowEnd ?? "20:00", "outbound.maxAttempts": over.maxAttempts ?? 2 } });
  await verifiedNumber(biz, over.callerId ?? "+14155550160", "both");
  return { biz, business: (await Business.findById(biz.business._id))! };
}
const consent = (businessId: any, phone: string, purpose: any = "reservation_reminder") => OutboundConsent.create({ businessId, phone, purpose, evidence: "Checked the SMS/voice consent box on the booking form, 2027-03-01" });
const cand = (b: { business: { _id: any } }, over: object = {}): any => ({ businessId: b.business._id, purpose: "reservation_reminder", toNumber: "+13105550111", callerIdNumber: "+14155550160", attempts: 0, maxAttempts: 2, ...over });

describe("outbound compliance policy", () => {
  it("allows a call only when every rule passes", async () => {
    const { biz, business } = await outboundBiz();
    await consent(biz.business._id, "+13105550111");
    expect(await evaluateOutbound(business, cand(biz), NOON)).toMatchObject({ allowed: true, reasons: [] });
  });

  it("blocks each failing rule with its own reason", async () => {
    const { biz, business } = await outboundBiz();
    await consent(biz.business._id, "+13105550111");
    const why = async (over: object, b = business, now = NOON) => (await evaluateOutbound(b, cand(biz, over), now)).reasons.join(" | ");

    expect(await why({ toNumber: "12345" })).toMatch(/not a valid international number/);
    expect(await why({ purpose: "order_status" })).toMatch(/no recorded consent/);
    expect(await why({ callerIdNumber: "+14155550199" })).toMatch(/caller ID/);
    expect(await why({ attempts: 2 })).toMatch(/maximum number of attempts/);
    expect(await why({ purpose: "approved_follow_up" })).toMatch(/not been approved by a staff member/);

    process.env.FEATURE_OUTBOUND_CALLING = "false";
    expect(await why({})).toMatch(/switched off for this deployment/);
    process.env.FEATURE_OUTBOUND_CALLING = "true";

    await Business.updateOne({ _id: biz.business._id }, { "outbound.enabled": false });
    expect(await why({}, (await Business.findById(biz.business._id))!)).toMatch(/not enabled for this business/);
    await Business.updateOne({ _id: biz.business._id }, { "outbound.enabled": true, "outbound.purposes": ["customer_callback"] });
    expect(await why({}, (await Business.findById(biz.business._id))!)).toMatch(/has not been approved by the business/);
  });

  it("the do-not-call list overrides everything, and revoked consent no longer counts", async () => {
    const { biz, business } = await outboundBiz();
    const c = await consent(biz.business._id, "+13105550111");
    await SuppressionEntry.create({ businessId: biz.business._id, phone: "+13105550111" });
    const d = await evaluateOutbound(business, cand(biz), NOON);
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/do-not-call/);
    await SuppressionEntry.deleteMany({});
    await OutboundConsent.updateOne({ _id: c._id }, { revokedAt: new Date() });
    expect((await evaluateOutbound(business, cand(biz), NOON)).reasons.join()).toMatch(/no recorded consent/);
  });

  it("customer-initiated purposes need the customer's own request for THIS number", async () => {
    const { biz, business } = await outboundBiz();
    const res = await Reservation.create({ businessId: biz.business._id, confirmationCode: "SD-ABCDEF", guestName: "G", guestPhone: "+13105550111", roomTypeId: new Types.ObjectId(), roomTypeName: "Deluxe", checkIn: "2027-04-01", checkOut: "2027-04-03", nights: 2, guests: 2, nightlyRate: 100, totalAmount: 200, status: "confirmed" } as never);
    expect((await evaluateOutbound(business, cand(biz, { reservationId: res._id }), NOON)).allowed).toBe(true);
    expect((await evaluateOutbound(business, cand(biz, { reservationId: res._id, toNumber: "+13105550999" }), NOON)).allowed).toBe(false); // a different number
    await Reservation.updateOne({ _id: res._id }, { status: "cancelled" });
    expect((await evaluateOutbound(business, cand(biz, { reservationId: res._id }), NOON)).allowed).toBe(false);

    const f = await FollowUp.create({ businessId: biz.business._id, phone: "+13105550111", reason: "Please call me back" });
    expect((await evaluateOutbound(business, cand(biz, { purpose: "customer_callback", followUpId: f._id }), NOON)).allowed).toBe(true);
    expect((await evaluateOutbound(business, cand(biz, { purpose: "customer_callback", followUpId: f._id, toNumber: "+13105550998" }), NOON)).allowed).toBe(false);
  });

  it("enforces calling hours in the recipient's time zone, never wider than 8am-9pm, and says when to retry", async () => {
    expect(localMinutes(NOON, "America/New_York")).toBe(12 * 60);
    expect(localMinutes(NOON, "America/Los_Angeles")).toBe(9 * 60);
    expect(withinCallingHours(NIGHT, "America/New_York", "09:00", "20:00")).toBe(false);
    expect(withinCallingHours(new Date("2027-03-10T12:30:00Z"), "America/New_York", "06:00", "23:00")).toBe(false); // 7:30 local: clamped to 8:00
    expect(withinCallingHours(new Date("2027-03-10T13:30:00Z"), "America/New_York", "06:00", "23:00")).toBe(true);

    const { biz, business } = await outboundBiz();
    await consent(biz.business._id, "+13105550111");
    const d = await evaluateOutbound(business, cand(biz), NIGHT);
    expect(d.allowed).toBe(false);
    expect(d.retryAt).toBeTruthy();
    expect(withinCallingHours(d.retryAt!, "America/New_York", "09:00", "20:00")).toBe(true);
    // 9am New York is 6am in Los Angeles: a Los Angeles recipient is not called yet.
    const at9ny = new Date("2027-03-10T14:00:00Z");
    expect((await evaluateOutbound(business, cand(biz), at9ny)).allowed).toBe(true);
    expect((await evaluateOutbound(business, cand(biz, { recipientTimezone: "America/Los_Angeles" }), at9ny)).allowed).toBe(false);
  });
});

describe("outbound requests and dispatch", () => {
  const twilioReady = async (biz: { business: { _id: any }; email: string }, rest: object) => {
    const owner = await login(biz.email);
    await owner.post("/api/telephony/connections").send({ kind: "twilio", settings: {}, secrets: { accountSid: "AC" + "b".repeat(32), authToken: "tok" } });
    __setTwilioRestForTest((() => rest) as never);
    await TelephonyConnection.updateOne({ businessId: biz.business._id, kind: "twilio" }, { status: "connected", lastCheckedAt: new Date() });
  };
  const fakeRest = (log: string[], opts: { fail?: boolean } = {}) => ({
    api: { accounts: () => ({ fetch: async () => ({}) }) },
    calls: Object.assign(() => ({ update: async () => ({}) }), {
      create: async (p: { from: string; to: string; url: string }) => { log.push(`${p.from}>${p.to}`); if (opts.fail) throw new Error("carrier rejected"); return { sid: `CA${String(log.length).padStart(32, "0")}` }; },
    }),
  });
  const req = (b: { biz: { business: { _id: any } } }, over: object = {}): any => ({ businessId: b.biz.business._id, idempotencyKey: "reminder-res-0001", purpose: "reservation_reminder" as const, toNumber: "+13105550111", callerIdNumber: "+14155550160", requestedBy: "owner@test.dev", ...over });

  it("is idempotent, records blocked requests with their reason, and defers out-of-hours ones", async () => {
    const o = await outboundBiz();
    const first = await requestOutbound(req(o), NOON);
    expect(first.duplicate).toBe(false);
    expect(first.request.status).toBe("blocked"); // no consent yet
    expect(first.request.blockedReason).toMatch(/no recorded consent/);
    expect(first.request.audit.map((a) => a.event)).toEqual(["requested", "blocked"]);
    const again = await requestOutbound(req(o), NOON);
    expect(again.duplicate).toBe(true);
    expect(await OutboundCallRequest.countDocuments()).toBe(1);

    await consent(o.biz.business._id, "+13105550111");
    const night = await requestOutbound(req(o, { idempotencyKey: "reminder-res-0002" }), NIGHT);
    expect(night.request.status).toBe("scheduled");
    expect(night.request.nextAttemptAt!.getTime()).toBeGreaterThan(NIGHT.getTime());
    expect(night.request.audit.map((a) => a.event)).toContain("deferred");
  });

  it("places the call through a healthy provider, once, and marks the call as outbound", async () => {
    const o = await outboundBiz();
    await consent(o.biz.business._id, "+13105550111");
    const log: string[] = [];
    await twilioReady(o.biz, fakeRest(log));
    await requestOutbound(req(o), NOON);
    const [a, b] = await Promise.all([dispatchDue(NOON), dispatchDue(NOON)]); // two workers at once
    expect([...a, ...b]).toHaveLength(1);
    expect(log).toEqual(["+14155550160>+13105550111"]);
    const r = (await OutboundCallRequest.findOne())!;
    expect(r).toMatchObject({ status: "dialing", attempts: 1 });
    const call = (await Call.findById(r.callId))!;
    expect(call).toMatchObject({ direction: "outbound", provider: "twilio" });
    expect(call.providerCallId).toMatch(/^CA/);
    expect(await dispatchDue(NOON)).toEqual([]); // nothing left to dial
  });

  it("does not dial when consent was withdrawn after the request, or when the provider is not usable", async () => {
    const o = await outboundBiz();
    const c = await consent(o.biz.business._id, "+13105550111");
    const log: string[] = [];
    await twilioReady(o.biz, fakeRest(log));
    await requestOutbound(req(o), NOON);
    await OutboundConsent.updateOne({ _id: c._id }, { revokedAt: new Date() });
    expect((await dispatchDue(NOON))[0].outcome).toBe("blocked");
    expect(log).toEqual([]);

    const o2 = await outboundBiz({ callerId: "+14155550161" });
    await consent(o2.biz.business._id, "+13105550111");
    await requestOutbound(req(o2, { idempotencyKey: "reminder-res-0003", callerIdNumber: "+14155550161" }), NOON); // no connection at all
    const out = await dispatchDue(NOON);
    expect(out[0].outcome).toBe("retry");
    expect((await OutboundCallRequest.findOne({ idempotencyKey: "reminder-res-0003" }))!.lastError).toMatch(/No provider could handle/);
  });

  it("fails over to the next provider, and gives up cleanly (one follow-up) after the attempt limit", async () => {
    const o = await outboundBiz({ maxAttempts: 2 });
    await consent(o.biz.business._id, "+13105550111");
    const log: string[] = [];
    await twilioReady(o.biz, fakeRest(log));
    const gw = await saveSipConnection(o.biz);
    await TelephonyConnection.updateOne({ _id: gw.id }, { status: "connected", lastCheckedAt: new Date() });
    __setSipFetchForTest((async () => new Response("", { status: 502 })) as never); // gateway down
    await requestOutbound(req(o), NOON);
    const first = await dispatchDue(NOON);
    expect(first[0].outcome).toBe("dialing"); // gateway failed, Twilio carried it
    expect(log).toHaveLength(1);
    expect((await OutboundCallRequest.findOne())!.audit.map((x) => x.detail).join()).toMatch(/failed/);

    // Now Twilio fails too: first attempt already used, second fails, then exhausted.
    const call = (await Call.findOne({ direction: "outbound" }))!;
    await twilioPost("/api/twilio/status", { CallSid: call.providerCallId, CallStatus: "no-answer" });
    expect((await OutboundCallRequest.findOne())!.status).toBe("scheduled"); // retry planned
    await OutboundCallRequest.updateOne({}, { nextAttemptAt: NOON });
    __setTwilioRestForTest((() => fakeRest(log, { fail: true })) as never);
    breakers.reset();
    expect((await dispatchDue(NOON))[0].outcome).toBe("exhausted");
    const r = (await OutboundCallRequest.findOne())!;
    expect(r.status).toBe("exhausted");
    expect(await FollowUp.countDocuments({ businessId: o.biz.business._id, reason: /could not be completed/ })).toBe(1);
  });

  it("the person answers: the call says who and why, an AI is disclosed, and 'stop calling' is honoured at once", async () => {
    const o = await outboundBiz();
    await consent(o.biz.business._id, "+13105550111");
    const log: string[] = [];
    await twilioReady(o.biz, fakeRest(log));
    await requestOutbound(req(o, { recipientName: "Dana Reed", message: "Check-in is tomorrow from 3 PM." }), NOON);
    await dispatchDue(NOON);
    const r = (await OutboundCallRequest.findOne())!;
    const call = (await Call.findById(r.callId))!;

    const answer = await twilioPost(`/api/twilio/outbound?callId=${call._id}&requestId=${r._id}`, { CallSid: call.providerCallId });
    expect(answer.text).toMatch(/Hello Dana/);
    expect(answer.text).toMatch(/AI assistant calling from Outbound Hotel/);
    expect(answer.text).toMatch(/remind you about your reservation/);
    expect(answer.text).toMatch(/stop calling/i);

    // a retried answer for someone else's call id is refused
    const bad = await twilioPost(`/api/twilio/outbound?callId=${call._id}&requestId=${r._id}`, { CallSid: "CAother" });
    expect(bad.text).toMatch(/technical difficulties/);

    const stop = await twilioPost(`/api/twilio/gather?callId=${call._id}`, { CallSid: call.providerCallId, SpeechResult: "Please stop calling me" });
    expect(stop.text).toMatch(/won't call you again/);
    expect(stop.text).toContain("<Hangup");
    expect(await SuppressionEntry.countDocuments({ businessId: o.biz.business._id, phone: "+13105550111", reason: "opt_out_on_call" })).toBe(1);

    // From now on the policy refuses this number, whatever consent exists.
    const next = await requestOutbound(req(o, { idempotencyKey: "reminder-res-0009" }), NOON);
    expect(next.request.status).toBe("blocked");
    expect(next.request.blockedReason).toMatch(/do-not-call/);
  });

  it("a number added to the do-not-call list after the call was placed is hung up on before any speech", async () => {
    const o = await outboundBiz();
    await consent(o.biz.business._id, "+13105550111");
    await twilioReady(o.biz, fakeRest([]));
    await requestOutbound(req(o), NOON);
    await dispatchDue(NOON);
    const r = (await OutboundCallRequest.findOne())!;
    const call = (await Call.findById(r.callId))!;
    await SuppressionEntry.create({ businessId: o.biz.business._id, phone: "+13105550111" });
    const answer = await twilioPost(`/api/twilio/outbound?callId=${call._id}&requestId=${r._id}`, { CallSid: call.providerCallId });
    expect(answer.text).toContain("<Hangup");
    expect(answer.text).not.toContain("<Say");
  });

  it("API: owner can request, staff cannot, and a duplicate key returns the same request; scheduler needs its secret", async () => {
    const o = await outboundBiz();
    await consent(o.biz.business._id, "+13105550111");
    const owner = await login(o.biz.email);
    const body = { idempotencyKey: "api-reminder-0001", purpose: "reservation_reminder", toNumber: "+13105550111", callerIdNumber: "+14155550160", recipientTimezone: "America/New_York" };
    const r1 = await owner.post("/api/outbound").send(body);
    const r2 = await owner.post("/api/outbound").send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.request._id).toBe(r1.body.request._id);
    expect(await OutboundCallRequest.countDocuments()).toBe(1);

    expect((await request().post("/api/outbound").send(body)).status).toBe(401);
    expect((await request().post("/api/outbound/dispatch").send({})).status).toBe(401);
    process.env.CRON_SECRET = "c".repeat(32);
    expect((await makeClient().post("/api/outbound/dispatch").set("authorization", "Bearer wrong").send({})).status).toBe(401);
    expect((await makeClient().post("/api/outbound/dispatch").set("authorization", `Bearer ${"c".repeat(32)}`).send({})).status).toBe(200);

    const other = await makeBusiness();
    const intruder = await login(other.email);
    const id = r1.body.request._id;
    expect((await intruder.delete(`/api/outbound/${id}`)).status).toBe(409); // not theirs: cannot be cancelled
    expect((await owner.delete(`/api/outbound/${id}`)).status).toBe(200);
    expect((await intruder.get("/api/outbound")).body.requests).toHaveLength(0);
  });

  it("consent needs evidence, and consent cannot be recorded for a suppressed number", async () => {
    const o = await outboundBiz();
    const owner = await login(o.biz.email);
    expect((await owner.post("/api/outbound/consent").send({ phone: "+13105550111", purpose: "reservation_reminder", evidence: "" })).status).toBe(400);
    expect((await owner.post("/api/outbound/consent").send({ phone: "+13105550111", purpose: "reservation_reminder", evidence: "Booking form checkbox on 2027-03-01" })).status).toBe(201);
    expect((await owner.post("/api/outbound/suppression").send({ phone: "+13105550111" })).status).toBe(201);
    expect((await owner.post("/api/outbound/consent").send({ phone: "+13105550111", purpose: "reservation_reminder", evidence: "Booking form checkbox on 2027-03-02" })).status).toBe(409);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("voice turn endpoint (worker → StayDesk agent)", () => {
  async function liveCall() {
    const biz = await makeBusiness({ name: "Voice Hotel" });
    const { id } = await saveSipConnection(biz);
    await verifiedNumber(biz, "+14155550170");
    const decision = (await signedPost(id, { events: [{ type: "incoming", providerCallId: "sip-v1", from: "+13105550100", to: "+14155550170" }] })).body.decisions[0];
    return { biz, id, callId: decision.callId as string };
  }
  const turn = (id: string, payload: object, o: { secret?: string; conn?: string } = {}) => {
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    return makeClient().post("/api/voice/turn").set("x-staydesk-connection", o.conn ?? id).set("x-staydesk-timestamp", String(ts)).set("x-staydesk-signature", signPayload(o.secret ?? GATEWAY_SECRET, ts, body)).send(payload);
  };

  it("answers from the real agent, is idempotent on messageId, and records latency", async () => {
    const { id, callId } = await liveCall();
    const msg = { callId, messageId: "worker-msg-0001", text: "Do you have parking?", turnMs: 640 };
    const first = await turn(id, msg);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ late: false, messageId: "worker-msg-0001" });
    expect(first.body.reply).toMatch(/\$20/); // from the business knowledge, not invented
    const retry = await turn(id, msg);
    expect(retry.body.reply).toBe(first.body.reply);
    expect(retry.body.responseId).toBe(first.body.responseId);
    const segs = (await (await import("../server/models")).CallTranscript.findOne({ callId }))!.segments.filter((s) => s.role === "caller");
    expect(segs).toHaveLength(1);
    expect((await CallSession.findOne({ providerCallId: "sip-v1" }))!.latency!.turns).toBe(2); // the worker reported two measurements
  });

  it("rejects bad signatures, unknown calls, another tenant's call, and ended calls", async () => {
    const { id, callId } = await liveCall();
    const msg = { callId, messageId: "worker-msg-0002", text: "hello there" };
    expect((await turn(id, msg, { secret: "z".repeat(40) })).status).toBe(401);
    expect((await turn(id, { ...msg, callId: "0".repeat(24) })).status).toBe(404);

    const other = await makeBusiness();
    const { id: otherConn } = await saveSipConnection(other);
    expect((await turn(otherConn, msg)).status).toBe(404); // a valid worker for a DIFFERENT business cannot speak on this call

    await signedPost(id, { events: [{ type: "status", providerCallId: "sip-v1", status: "completed", reason: "caller_hangup" }] });
    expect((await turn(id, { ...msg, messageId: "worker-msg-0003" })).status).toBe(409);
  });

  it("never leaves the caller in silence: a slow engine gets a holding reply, and the same messageId later returns the real answer", async () => {
    const { runVoiceTurn } = await import("../server/services/voice/orchestrator");
    process.env.VOICE_TURN_TIMEOUT_MS = "50";
    const slow = { id: "slow", turn: async () => { await new Promise((r) => setTimeout(r, 200)); return { reply: "real answer", end: false, transfer: false, intent: "x", messageId: "m1-aaaaaaaa", responseId: "r1" }; } };
    const late = await runVoiceTurn({ callId: "0".repeat(24), messageId: "m1-aaaaaaaa", text: "hello", engine: slow });
    expect(late).toMatchObject({ late: true, end: false });
    expect(late.reply).toMatch(/taking longer/);
    const failing = { id: "bad", turn: async () => { throw new Error("engine down"); } };
    const failed = await runVoiceTurn({ callId: "0".repeat(24), messageId: "m2-aaaaaaaa", text: "hello", engine: failing });
    expect(failed.late).toBe(true);
    expect(failed.reply).not.toMatch(/confirmed/i);
    delete process.env.VOICE_TURN_TIMEOUT_MS;
  });

  it("card numbers spoken to the worker never reach the transcript", async () => {
    const { id, callId } = await liveCall();
    await turn(id, { callId, messageId: "worker-msg-0004", text: "my card number is 4111 1111 1111 1111" });
    const t = (await (await import("../server/models")).CallTranscript.findOne({ callId }))!;
    expect(JSON.stringify(t.toObject())).not.toContain("4111");
  });
});

describe("session cleanup", () => {
  it("closes sessions that never reported an end, frees capacity, and queues one callback", async () => {
    const { reapStaleSessions } = await import("../server/services/telephony/core/sessions");
    const biz = await makeBusiness();
    const { id } = await saveSipConnection(biz);
    await verifiedNumber(biz, "+14155550180");
    const callId = (await signedPost(id, { events: [{ type: "incoming", providerCallId: "sip-old", from: "+13105550100", to: "+14155550180" }] })).body.decisions[0].callId;
    await signedPost(id, { events: [{ type: "incoming", providerCallId: "sip-new", from: "+13105550101", to: "+14155550180" }] });
    await CallSession.updateOne({ providerCallId: "sip-old" }, { startedAt: new Date(Date.now() - 5 * 3600_000) });

    expect(await reapStaleSessions()).toBe(1);
    expect(await reapStaleSessions()).toBe(0); // already closed
    expect((await CallSession.findOne({ providerCallId: "sip-old" }))).toMatchObject({ status: "failed", terminationReason: "timeout" });
    expect((await CallSession.findOne({ providerCallId: "sip-new" }))!.status).toBe("ringing"); // a fresh call is untouched
    expect((await Call.findById(callId))!.endedAt).toBeTruthy();
    expect(await CallRecoveryTask.countDocuments({ reason: "timeout" })).toBe(1);
  });
});
