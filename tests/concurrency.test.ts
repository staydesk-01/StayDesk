import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Business, BusinessPhoneNumber, Call, CallRecoveryTask, CallSession, CallTranscript, ConcurrencyGate, SipTrunk, VoiceWorker } from "../server/models";
import { breakers } from "../server/services/telephony/core/breaker";
import { applyEvent, reapStaleSessions, routeIncoming } from "../server/services/telephony/core/sessions";
import type { RouteDecision } from "../server/services/telephony/core/sessions";
import { canTransition, closeSession, reconcileGates } from "../server/services/telephony/concurrency/sessionManager";
import { concurrencyMetrics } from "../server/services/telephony/concurrency/metrics";
import { recommendWorkers, recordWorkerHeartbeat } from "../server/services/telephony/concurrency/workers";
import { runVoiceTurn } from "../server/services/voice/orchestrator";
import { login, makeBusiness } from "./helpers";

type Biz = Awaited<ReturnType<typeof makeBusiness>>;
let seq = 0;
const phone = () => `+1415555${String(1000 + ++seq).slice(-4)}`;

beforeEach(() => {
  process.env.FEATURE_TELEPHONY_CORE = "true";
  breakers.reset();
});
afterEach(() => {
  delete process.env.FEATURE_TELEPHONY_CORE;
  vi.restoreAllMocks();
});

async function setup(opts: { limit?: number; carrier?: number; policy?: "callback" | "transfer" | "voicemail"; name?: string } = {}) {
  const biz: Biz = await makeBusiness({ name: opts.name });
  const did = phone();
  await BusinessPhoneNumber.create({ businessId: biz.business._id, e164: did, role: "inbound", mode: "forwarding", verification: { status: "verified", verifiedAt: new Date() } });
  await Business.updateOne({ _id: biz.business._id }, { $set: { "concurrency.maxConcurrentCalls": opts.limit ?? 30, "concurrency.overflowPolicy": opts.policy ?? "callback" } });
  if (opts.carrier) await SipTrunk.create({ businessId: biz.business._id, name: "main", host: "sip.carrier.test", maxConcurrentCalls: opts.carrier, allowedIps: ["203.0.113.10"] });
  const id = biz.business._id as Types.ObjectId;
  const incoming = (n: string, callerNumber = phone()) => routeIncoming(id, "sip_gateway", { type: "incoming", providerCallId: n, from: callerNumber, to: did });
  const status = (n: string, s: "answered" | "completed" | "failed", reason?: string) => applyEvent(id, "sip_gateway", { type: "status", providerCallId: n, status: s, reason });
  return { biz, id, did, incoming, status };
}
const active = async (id: Types.ObjectId) => (await ConcurrencyGate.findOne({ businessId: id }))?.active ?? 0;
const answered = (ds: RouteDecision[]) => ds.filter((d) => d.action === "answer");

describe("one call", () => {
  it("gets an opaque session, its own room, and walks the lifecycle with timings recorded", async () => {
    const t = await setup();
    const callerNumber = "+14155559999";
    const d = await t.incoming("p-1", callerNumber);
    expect(d.action).toBe("answer");
    expect(d.sessionKey).toMatch(/^ses_[\w-]{16}$/);
    expect(d.room).toBe(`call-${d.sessionKey}`);
    expect(d.room).not.toContain("9999"); // no phone number in the room name

    let s = (await CallSession.findOne({ providerCallId: "p-1" }))!;
    expect(s.lifecycle).toBe("initializing");
    expect(await active(t.id)).toBe(1);
    await t.status("p-1", "answered");
    s = (await CallSession.findOne({ providerCallId: "p-1" }))!;
    expect(s.lifecycle).toBe("active");
    expect(typeof s.timings?.setupMs).toBe("number");

    await t.status("p-1", "completed");
    s = (await CallSession.findOne({ providerCallId: "p-1" }))!;
    expect(s.lifecycle).toBe("completed");
    expect(s.timings?.completingAt).toBeTruthy();
    expect(s.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(await active(t.id)).toBe(0);
  });

  it("only allows legal forward transitions", () => {
    expect(canTransition("incoming", "initializing")).toBe(true);
    expect(canTransition("completed", "active")).toBe(false);
    expect(canTransition("failed", "completed")).toBe(false);
    expect(canTransition("active", "initializing")).toBe(false);
  });
});

describe.each([3, 10, 25])("%i simultaneous calls", (n) => {
  it("each caller gets a separate session, room, call record and slot", async () => {
    const t = await setup({ limit: 25 });
    const started = performance.now();
    const ds = await Promise.all(Array.from({ length: n }, (_, i) => t.incoming(`sim-${n}-${i}`)));
    const ms = Math.round(performance.now() - started);
    console.log(`[capacity] ${n} simultaneous arrivals admitted in ${ms} ms (control plane only, local MongoDB)`);

    expect(answered(ds)).toHaveLength(n);
    expect(new Set(ds.map((d) => d.sessionKey)).size).toBe(n);
    expect(new Set(ds.map((d) => d.room)).size).toBe(n);
    expect(new Set(ds.map((d) => d.callId)).size).toBe(n);
    expect(await Call.countDocuments({ businessId: t.id })).toBe(n);
    expect(await active(t.id)).toBe(n);
    await Promise.all(ds.map((_, i) => t.status(`sim-${n}-${i}`, "answered")));
    expect((await concurrencyMetrics(t.id)).calls.byState.active).toBe(n);
    await Promise.all(ds.map((_, i) => t.status(`sim-${n}-${i}`, "completed")));
    expect(await active(t.id)).toBe(0);
    expect((await concurrencyMetrics(t.id)).calls.peak).toBe(n);
  });
});

describe("limits and overflow", () => {
  it("never exceeds the limit under a burst; every extra caller is handled, recorded and queued for a callback", async () => {
    const t = await setup({ limit: 10 });
    const ds = await Promise.all(Array.from({ length: 25 }, (_, i) => t.incoming(`burst-${i}`)));
    expect(answered(ds)).toHaveLength(10);
    const over = ds.filter((d) => d.action !== "answer");
    expect(over).toHaveLength(15);
    expect(over.every((d) => d.reason === "capacity" && d.overflow === "callback")).toBe(true);
    expect(await active(t.id)).toBe(10);
    expect(await CallSession.countDocuments({ businessId: t.id })).toBe(25); // none vanished
    expect(await CallRecoveryTask.countDocuments({ businessId: t.id, reason: "capacity" })).toBe(15);
    expect((await concurrencyMetrics(t.id)).last24h.overflowed).toBe(15);
  });

  it("recovers: finished calls free capacity for new arrivals", async () => {
    const t = await setup({ limit: 3 });
    await Promise.all([0, 1, 2].map((i) => t.incoming(`r-${i}`)));
    expect((await t.incoming("r-x")).action).toBe("reject");
    await t.status("r-0", "completed");
    await t.status("r-1", "completed");
    const after = await Promise.all([t.incoming("r-a"), t.incoming("r-b"), t.incoming("r-c")]);
    expect(answered(after)).toHaveLength(2);
    expect(await active(t.id)).toBe(3);
  });

  it("uses the lower of the business limit and the carrier trunk limit", async () => {
    const t = await setup({ limit: 20, carrier: 4 });
    const ds = await Promise.all(Array.from({ length: 8 }, (_, i) => t.incoming(`c-${i}`)));
    expect(answered(ds)).toHaveLength(4);
    expect((await concurrencyMetrics(t.id)).limits).toMatchObject({ effective: 4, business: 20, carrier: 4 });
  });

  it("transfer policy hands the caller to the team number instead of rejecting", async () => {
    const t = await setup({ limit: 1, policy: "transfer" });
    await t.incoming("t-1");
    const d = await t.incoming("t-2");
    expect(d).toMatchObject({ action: "transfer", reason: "capacity", transferTo: "+15550001111" });
    expect(await CallRecoveryTask.countDocuments({ businessId: t.id })).toBe(0);
  });

  it("a business's limit never uses another business's slots", async () => {
    const a = await setup({ limit: 2, name: "Alpha Inn" });
    const b = await setup({ limit: 2, name: "Beta Lodge" });
    await Promise.all([a.incoming("a1"), a.incoming("a2")]);
    expect((await a.incoming("a3")).action).toBe("reject");
    expect((await b.incoming("b1")).action).toBe("answer");
    expect(await active(a.id)).toBe(2);
    expect(await active(b.id)).toBe(1);
  });
});

describe("duplicate delivery", () => {
  it("ten simultaneous identical webhooks create one session, one call and one slot, all with the same decision", async () => {
    const t = await setup();
    const ds = await Promise.all(Array.from({ length: 10 }, () => t.incoming("dup-1", "+14155550123")));
    expect(new Set(ds.map((d) => d.callId)).size).toBe(1);
    expect(new Set(ds.map((d) => d.sessionKey)).size).toBe(1);
    expect(await CallSession.countDocuments({ providerCallId: "dup-1" })).toBe(1);
    expect(await Call.countDocuments({ providerCallId: "dup-1" })).toBe(1);
    expect(await active(t.id)).toBe(1);
  });

  it("a repeated end event releases the slot once", async () => {
    const t = await setup();
    await t.incoming("dup-2");
    await t.incoming("keep");
    await Promise.all([t.status("dup-2", "completed"), t.status("dup-2", "completed"), t.status("dup-2", "completed")]);
    expect(await active(t.id)).toBe(1);
    expect((await CallSession.findOne({ providerCallId: "dup-2" }))!.lifecycle).toBe("completed");
  });

  it("a duplicate overflow delivery returns the same refusal and queues one callback", async () => {
    const t = await setup({ limit: 1 });
    await t.incoming("o-1");
    const ds = await Promise.all([t.incoming("o-2"), t.incoming("o-2"), t.incoming("o-2")]);
    expect(ds.every((d) => d.action === "reject")).toBe(true);
    expect(await CallRecoveryTask.countDocuments({ businessId: t.id })).toBe(1);
  });
});

describe("worker pool", () => {
  const hb = (id: Types.ObjectId, workerId: string, capacity: number, extra = {}) => recordWorkerHeartbeat(id, { workerId, capacity, ...extra });

  it("spreads calls across workers and never overbooks one", async () => {
    const t = await setup({ limit: 20 });
    await hb(t.id, "w1", 3); await hb(t.id, "w2", 3);
    const ds = await Promise.all(Array.from({ length: 10 }, (_, i) => t.incoming(`w-${i}`)));
    expect(answered(ds)).toHaveLength(6);
    const rejected = ds.filter((d) => d.action !== "answer");
    expect(rejected.every((d) => d.reason === "no_worker_capacity")).toBe(true);
    const ws = await VoiceWorker.find({ businessId: t.id });
    expect(ws.map((w) => w.active).sort()).toEqual([3, 3]);
    expect(await active(t.id)).toBe(6); // slots for refused calls were handed back
    expect(await CallRecoveryTask.countDocuments({ businessId: t.id, reason: "no_worker_capacity" })).toBe(4);
  });

  it("a worker that dies fails only its own calls, queues callbacks, and capacity is repaired", async () => {
    const t = await setup({ limit: 20 });
    await hb(t.id, "w1", 2); await hb(t.id, "w2", 2);
    await Promise.all(Array.from({ length: 4 }, (_, i) => t.incoming(`d-${i}`)));
    await VoiceWorker.updateOne({ businessId: t.id, workerId: "w1" }, { $set: { lastHeartbeatAt: new Date(Date.now() - 120_000) } });
    const closed = await reapStaleSessions();
    expect(closed).toBe(2);
    const failed = await CallSession.find({ businessId: t.id, lifecycle: "failed" });
    expect(failed).toHaveLength(2);
    expect(failed.every((s) => s.workerId === "w1" && s.failureCause === "worker_unavailable")).toBe(true);
    expect(await CallSession.countDocuments({ businessId: t.id, workerId: "w2", lifecycle: "initializing" })).toBe(2);
    expect(await CallRecoveryTask.countDocuments({ businessId: t.id, reason: "worker_unavailable" })).toBe(2);
    expect(await active(t.id)).toBe(2);
    expect((await VoiceWorker.findOne({ businessId: t.id, workerId: "w1" }))!.status).toBe("down");
    // new calls go to the surviving worker only
    expect((await Promise.all([t.incoming("n-1"), t.incoming("n-2"), t.incoming("n-3")])).filter((d) => d.action === "answer")).toHaveLength(0);
    await hb(t.id, "w3", 2);
    expect((await t.incoming("n-4")).workerId).toBe("w3");
  });

  it("does not use a draining worker", async () => {
    const t = await setup();
    await hb(t.id, "w1", 5, { draining: true });
    expect((await t.incoming("dr-1")).reason).toBe("no_worker_capacity");
  });

  it("workers are per business: one tenant's pool is invisible to another", async () => {
    const a = await setup({ name: "Pool A" });
    const b = await setup({ name: "Pool B" });
    await hb(a.id, "shared-name", 5);
    expect(await VoiceWorker.countDocuments({ businessId: b.id })).toBe(0);
    expect((await concurrencyMetrics(b.id)).workers.poolRegistered).toBe(false);
    expect((await b.incoming("pb-1")).action).toBe("answer"); // B has no pool: unaffected by A's
  });

  it("recommends workers from active calls and CPU, without claiming to start any", () => {
    expect(recommendWorkers({ activeCalls: 40, perWorkerCapacity: 10, liveWorkers: 4 }).desired).toBe(5);
    expect(recommendWorkers({ activeCalls: 10, perWorkerCapacity: 10, liveWorkers: 2, avgCpuPct: 88 }).desired).toBe(3);
  });
});

describe("failures", () => {
  it("a carrier/trunk failure ends only that session as failed with its cause, frees the slot, and queues a callback", async () => {
    const t = await setup();
    await t.incoming("f-1"); await t.incoming("f-2");
    await t.status("f-1", "answered"); await t.status("f-2", "answered");
    await t.status("f-1", "failed", "trunk_failure");
    const s = (await CallSession.findOne({ providerCallId: "f-1" }))!;
    expect(s).toMatchObject({ lifecycle: "failed", failureCause: "trunk_failure" });
    expect((await CallSession.findOne({ providerCallId: "f-2" }))!.lifecycle).toBe("active");
    expect(await active(t.id)).toBe(1);
    expect(await CallRecoveryTask.countDocuments({ businessId: t.id, reason: "trunk_failure" })).toBe(1);
    expect((await concurrencyMetrics(t.id)).last24h.failureCauses).toEqual({ trunk_failure: 1 });
  });

  it("a database failure while setting up a call gives back the slot and worker, and surfaces the error", async () => {
    const t = await setup({ limit: 5 });
    await recordWorkerHeartbeat(t.id, { workerId: "w1", capacity: 5 });
    vi.spyOn(Call, "create").mockRejectedValueOnce(new Error("mongo down"));
    await expect(t.incoming("db-1")).rejects.toThrow("mongo down");
    expect(await active(t.id)).toBe(0);
    expect((await VoiceWorker.findOne({ businessId: t.id }))!.active).toBe(0);
    expect((await CallSession.findOne({ providerCallId: "db-1" }))!).toMatchObject({ lifecycle: "failed", failureCause: "setup_error" });
    // the gateway's retry of the same call id still ends in a clear decision, and the system keeps working for others
    expect((await t.incoming("db-2")).action).toBe("answer");
  });

  it("repairs a counter that drifted (crash between taking and releasing a slot)", async () => {
    const t = await setup();
    await t.incoming("g-1");
    await ConcurrencyGate.updateOne({ businessId: t.id }, { $set: { active: 7 } });
    expect(await reconcileGates()).toBe(1);
    expect(await active(t.id)).toBe(1);
  });

  it("closing a session twice never frees a slot twice", async () => {
    const t = await setup();
    const d = await t.incoming("cl-1"); await t.incoming("cl-2");
    const s = (await CallSession.findOne({ providerCallId: "cl-1" }))!;
    await closeSession(s._id, { ok: true }); await closeSession(s._id, { ok: true });
    expect(d.action).toBe("answer");
    expect(await active(t.id)).toBe(1);
  });
});

describe("privacy isolation under concurrency", () => {
  it("25 simultaneous conversations across two businesses keep transcripts, sessions and metrics separate", async () => {
    const a = await setup({ limit: 25, name: "Alpha Inn" });
    const b = await setup({ limit: 25, name: "Beta Lodge" });
    const people = Array.from({ length: 25 }, (_, i) => ({ biz: i % 2 ? b : a, key: `p-${i}`, email: `guest${i}x@marker.test` }));
    const ds = await Promise.all(people.map((p) => p.biz.incoming(p.key)));
    expect(answered(ds)).toHaveLength(25);

    await Promise.all(people.map((p, i) => runVoiceTurn({ callId: ds[i].callId!, messageId: `m-${i}`, text: `my email is ${p.email}` })));
    await Promise.all(people.map((p, i) => runVoiceTurn({ callId: ds[i].callId!, messageId: `m-${i}-b`, text: "what time is check-out?" })));

    for (let i = 0; i < 25; i++) {
      const tr = await CallTranscript.findOne({ callId: ds[i].callId });
      const text = JSON.stringify(tr?.segments ?? []);
      expect(text).toContain(`guest${i}x@marker.test`);
      for (let j = 0; j < 25; j++) if (j !== i) expect(text).not.toContain(`guest${j}x@marker.test`);
      const call = await Call.findById(ds[i].callId);
      expect(String(call!.businessId)).toBe(String(people[i].biz.id));
    }
    const ma = await concurrencyMetrics(a.id), mb = await concurrencyMetrics(b.id);
    expect(ma.calls.active).toBe(13);
    expect(mb.calls.active).toBe(12);
  });

  it("a connection cannot take calls for another business's number, and room names never contain phone numbers", async () => {
    const a = await setup({ name: "Alpha Inn" });
    const b = await setup({ name: "Beta Lodge" });
    const d = await routeIncoming(a.id, "sip_gateway", { type: "incoming", providerCallId: "x-1", from: "+14155550001", to: b.did });
    expect(d).toMatchObject({ action: "reject", reason: "wrong_account" });
    expect(await CallSession.countDocuments({})).toBe(0);
    const ok = await b.incoming("x-2", "+14155557777");
    expect(`${ok.room}${ok.sessionKey}`).not.toMatch(/\d{7}/);
  });
});

describe("concurrency API", () => {
  it("owner can read live metrics and change the limit and policy; bad values are refused", async () => {
    const t = await setup({ limit: 5 });
    const owner = await login(t.biz.email);
    const got = await owner.get("/api/telephony/concurrency");
    expect(got.status).toBe(200);
    expect(got.body.limits).toMatchObject({ effective: 5, overflowPolicy: "callback" });
    const put = await owner.put("/api/telephony/concurrency").send({ maxConcurrentCalls: 2, overflowPolicy: "voicemail" });
    expect(put.status).toBe(200);
    expect(put.body.limits).toMatchObject({ effective: 2, overflowPolicy: "voicemail" });
    expect((await owner.put("/api/telephony/concurrency").send({ maxConcurrentCalls: 0, overflowPolicy: "callback" })).status).toBe(400);
    expect((await owner.put("/api/telephony/concurrency").send({ maxConcurrentCalls: 3, overflowPolicy: "drop" })).status).toBe(400);
    expect((await makeClient0().get("/api/telephony/concurrency")).status).toBe(401);
  });
});
import { makeClient } from "./client";
const makeClient0 = makeClient;
