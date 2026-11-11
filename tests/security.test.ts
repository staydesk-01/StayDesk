import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog, Business, Call, LoginEvent, Recording, User } from "../server/models";
import { __setRecordingFetchForTest, LINK_TTL_MS, signLink, verifyLink } from "../server/services/recordings/recordingService";
import { purgeExpiredRecordings } from "../server/services/recordings/recordingService";
import { base32Encode, totpAt, verifyTotp } from "../server/utils/totp";
import { login, makeBusiness, newCallSid, twilioPost } from "./helpers";
import { makeClient } from "./client";

const AUDIO = "FAKE-MP3-AUDIO-BYTES-0123456789";
const REC_URL = "https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/RE1";

beforeEach(() => {
  process.env.TELEPHONY_SECRET_KEY = "k".repeat(40);
  __setRecordingFetchForTest(async (_u, init) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(AUDIO, { status: 200 })));
});
afterEach(() => {
  delete process.env.TELEPHONY_SECRET_KEY;
  __setRecordingFetchForTest(null);
  vi.restoreAllMocks();
});

async function withRecording(opts: { name?: string; enabled?: boolean } = {}) {
  const biz = await makeBusiness({ name: opts.name });
  await Business.updateOne({ _id: biz.business._id }, { $set: { "privacy.recordingEnabled": opts.enabled ?? true } });
  const sid = newCallSid();
  const call = await Call.create({ businessId: biz.business._id, provider: "twilio", providerCallId: sid, callerNumber: "+14155551234", routingReason: "direct_ai", callerName: "Pat Caller" });
  const hook = await twilioPost("/api/twilio/recording", { CallSid: sid, RecordingUrl: REC_URL, RecordingSid: `RE${sid.slice(-6)}`, RecordingDuration: "42" });
  expect(hook.status).toBe(204);
  const rec = await Recording.findOne({ callId: call._id });
  const owner = await login(biz.email);
  return { biz, call, rec, owner, sid };
}
async function staffOf(biz: Awaited<ReturnType<typeof makeBusiness>>, owner: Awaited<ReturnType<typeof login>>, email = "stan@test.dev") {
  expect((await owner.post("/api/team").send({ name: "Stan", email, password: "Password123!", role: "staff" })).status).toBe(201);
  return login(email);
}

describe("TOTP", () => {
  it("matches the RFC 6238 test vector and refuses replays", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082"); // RFC 6238 Appendix B (last 6 digits of 94287082)
    const now = 59_000;
    const step = verifyTotp(secret, "287082", 0, now);
    expect(step).toBe(1);
    expect(verifyTotp(secret, "287082", step!, now)).toBeNull();
    expect(verifyTotp(secret, "000000", 0, now)).toBeNull();
    expect(verifyTotp(secret, "28708", 0, now)).toBeNull();
  });
});

describe("unique call and recording identity", () => {
  it("every call and recording gets its own non-guessable UUID; a re-delivered webhook does not duplicate", async () => {
    const t = await withRecording();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(t.call.callUuid).toMatch(uuid);
    expect(t.rec!.recordingId).toMatch(uuid);
    expect(t.rec!.callUuid).toBe(t.call.callUuid);
    expect(t.rec!.consentAnnounced).toBe(true);
    await twilioPost("/api/twilio/recording", { CallSid: t.sid, RecordingUrl: REC_URL, RecordingSid: `RE${t.sid.slice(-6)}`, RecordingDuration: "42" });
    expect(await Recording.countDocuments({})).toBe(1);
    const c2 = await Call.create({ businessId: t.biz.business._id, provider: "twilio", providerCallId: newCallSid(), routingReason: "direct_ai" });
    expect(c2.callUuid).not.toBe(t.call.callUuid);
  });

  it("keeps nothing when recording is off, and refuses a recording hosted anywhere but Twilio", async () => {
    const off = await withRecording({ enabled: false });
    expect(off.rec).toBeNull();
    const on = await withRecording();
    const sid = newCallSid();
    await Call.create({ businessId: on.biz.business._id, provider: "twilio", providerCallId: sid, routingReason: "direct_ai" });
    await twilioPost("/api/twilio/recording", { CallSid: sid, RecordingUrl: "https://evil.example/steal.mp3", RecordingSid: "REevil" });
    expect(await Recording.countDocuments({ providerRecordingId: "REevil" })).toBe(0);
  });

  it("never returns the provider URL or storage reference through any API", async () => {
    const t = await withRecording();
    const detail = await t.owner.get(`/api/calls/${t.call._id}`);
    expect(JSON.stringify(detail.body)).not.toContain("api.twilio.com");
    expect(detail.body.call.recording.recordingId).toBe(t.rec!.recordingId);
    for (const url of ["/api/recordings", `/api/recordings/${t.rec!.recordingId}`]) expect(JSON.stringify((await t.owner.get(url)).body)).not.toContain("api.twilio.com");
  });
});

describe("secure recording access", () => {
  it("search by recording id, call id and date; filters; phone search for authorised users only", async () => {
    const t = await withRecording();
    const ids = async (q: string) => ((await t.owner.get(`/api/recordings?${q}`)).body.recordings as { recordingId: string }[]).map((r) => r.recordingId);
    expect(await ids(`q=${t.rec!.recordingId}`)).toEqual([t.rec!.recordingId]);
    expect(await ids(`q=${t.call.callUuid}`)).toEqual([t.rec!.recordingId]);
    expect(await ids(`q=${encodeURIComponent("+1 (415) 555-1234")}`)).toEqual([t.rec!.recordingId]);
    expect(await ids("q=%2B19998887777")).toEqual([]);
    expect(await ids("from=2020-01-01&to=2020-01-02")).toEqual([]);
    expect(await ids("filter=flagged")).toEqual([]);
    await t.owner.patch(`/api/recordings/${t.rec!.recordingId}`).send({ flagged: true, reason: "rude caller" });
    expect(await ids("filter=flagged")).toEqual([t.rec!.recordingId]);
    expect((await t.owner.get("/api/recordings?q=not-an-id")).status).toBe(400);

    const staff = await staffOf(t.biz, t.owner);
    const list = await staff.get("/api/recordings");
    expect(list.body.recordings[0].call.callerNumber).toBe("+1••• ••• 1234"); // masked
    expect(list.body.recordings[0].call.callerName).toBe("");
    expect((await staff.get("/api/recordings?q=%2B14155551234")).status).toBe(403);
  });

  it("staff cannot listen until the owner allows it, and the owner controls that setting", async () => {
    const t = await withRecording();
    const staff = await staffOf(t.biz, t.owner);
    const id = t.rec!.recordingId;
    expect((await staff.post(`/api/recordings/${id}/link`).send({})).status).toBe(403);
    expect((await staff.put("/api/security/settings").send({ staffCanListen: true })).status).toBe(403); // owner only
    expect((await t.owner.put("/api/security/settings").send({ staffCanListen: true })).status).toBe(200);
    expect((await staff.post(`/api/recordings/${id}/link`).send({})).status).toBe(200);
    await t.owner.put("/api/security/settings").send({ staffCanListen: false });
    expect((await staff.post(`/api/recordings/${id}/link`).send({})).status).toBe(403); // revoked immediately
  });

  it("issues a short-lived signed link, streams audio with range support, and audits each access", async () => {
    const t = await withRecording();
    const id = t.rec!.recordingId;
    const link = await t.owner.post(`/api/recordings/${id}/link`).send({ purpose: "download" });
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(new RegExp(`^/api/recordings/${id}/audio\\?token=`));
    const full = await t.owner.get(link.body.url);
    expect(full.status).toBe(200);
    expect(full.text).toBe(AUDIO);
    expect(full.headers["content-disposition"]).toContain(`recording-${id}.mp3`);
    expect(full.headers["cache-control"]).toContain("no-store");
    const part = await t.owner.get(link.body.url).set("range", "bytes=5-8");
    expect(part.status).toBe(206);
    expect(part.text).toBe(AUDIO.slice(5, 9));
    const actions = (await AuditLog.find({ entityId: id }).sort({ createdAt: 1 })).map((a) => a.action);
    expect(actions).toEqual(["recording.link_issued", "recording.downloaded", "recording.downloaded"]);
  });

  it("a link is useless to another user, another business, after expiry, or when tampered with", async () => {
    const t = await withRecording({ name: "Alpha Inn" });
    const other = await withRecording({ name: "Beta Lodge" });
    const id = t.rec!.recordingId;
    const staff = await staffOf(t.biz, t.owner);
    await t.owner.put("/api/security/settings").send({ staffCanListen: true });
    const { url } = (await t.owner.post(`/api/recordings/${id}/link`).send({})).body;
    expect((await staff.get(url)).status).toBe(403); // bound to the user it was issued to
    expect((await other.owner.get(url)).status).toBe(404); // other tenant: the recording does not exist for them
    expect((await other.owner.get(`/api/recordings/${id}`)).status).toBe(404);
    expect((await other.owner.post(`/api/recordings/${id}/link`).send({})).status).toBe(404);
    expect((await makeClient().get(url)).status).toBe(401); // no session
    const token = url.split("token=")[1];
    expect((await t.owner.get(url.replace(token, token.slice(0, -2) + "xx"))).status).toBe(403);
    const ownerId = String((await User.findOne({ email: t.biz.email }))!._id);
    const old = signLink(id, ownerId, "play", Date.now() - LINK_TTL_MS() - 1000);
    expect(verifyLink(old.token)).toBeNull();
    expect((await t.owner.get(`/api/recordings/${id}/audio?token=${old.token}`)).status).toBe(403);
    // a token for a different recording does not open this one
    expect((await t.owner.get(`/api/recordings/${id}/audio?token=${signLink(other.rec!.recordingId, ownerId, "play").token}`)).status).toBe(403);
  });

  it("fails closed: if the access cannot be written to the audit log, no audio is sent", async () => {
    const t = await withRecording();
    const { url } = (await t.owner.post(`/api/recordings/${t.rec!.recordingId}/link`).send({})).body;
    vi.spyOn(AuditLog, "create").mockRejectedValue(new Error("audit store down"));
    const res = await t.owner.get(url);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(AUDIO);
  });

  it("shows the transcript with the recording, and reports a provider outage honestly", async () => {
    const t = await withRecording();
    const id = t.rec!.recordingId;
    expect((await t.owner.get(`/api/recordings/${id}`)).body.transcriptStatus).toBe("none");
    __setRecordingFetchForTest(async () => new Response("no", { status: 500 }));
    const { url } = (await t.owner.post(`/api/recordings/${id}/link`).send({})).body;
    const down = await t.owner.get(url);
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe("provider_unavailable");
  });

  it("only the owner can delete; deletion is audited, removes access, and the provider result is recorded", async () => {
    const t = await withRecording();
    const id = t.rec!.recordingId;
    const staff = await staffOf(t.biz, t.owner);
    expect((await staff.delete(`/api/recordings/${id}`)).status).toBe(403);
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    const del = await t.owner.delete(`/api/recordings/${id}`);
    delete process.env.TWILIO_ACCOUNT_SID;
    expect(del.status).toBe(200);
    expect(await AuditLog.countDocuments({ entityId: id, action: "recording.deleted" })).toBe(1);
    expect((await t.owner.post(`/api/recordings/${id}/link`).send({})).status).toBe(404);
    const after = await Recording.findOne({ recordingId: id }).select("+storage.ref");
    expect(after!.status).toBe("deleted");
    expect(after!.storage?.ref).toBeUndefined();
  });

  it("retention deletes expired recordings and logs it as the system", async () => {
    const t = await withRecording();
    await Recording.updateOne({ _id: t.rec!._id }, { $set: { retentionUntil: new Date(Date.now() - 1000) } });
    expect(await purgeExpiredRecordings()).toBe(1);
    expect((await Recording.findById(t.rec!._id))!.status).toBe("deleted");
    expect(await AuditLog.findOne({ action: "recording.deleted", actorType: "system" })).toBeTruthy();
    expect(await purgeExpiredRecordings()).toBe(0);
  });
});

describe("sign-in protection and two-step verification", () => {
  const post = (email: string, password: string, code?: string) => makeClient().post("/api/auth/login").send({ email, password, ...(code ? { code } : {}) });

  it("locks an email after repeated failures (even with the right password), without revealing whether it exists", async () => {
    const biz = await makeBusiness();
    for (let i = 0; i < 5; i++) expect((await post(biz.email, "wrong")).status).toBe(401);
    const locked = await post(biz.email, "Password123!");
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("account_locked");
    for (let i = 0; i < 5; i++) await post("nobody@test.dev", "x");
    expect((await post("nobody@test.dev", "x")).status).toBe(429); // same behaviour for unknown emails
    expect(await LoginEvent.countDocuments({ email: biz.email, outcome: "locked" })).toBe(1);
  });

  it("a successful sign-in resets the failure count", async () => {
    const biz = await makeBusiness();
    for (let i = 0; i < 4; i++) await post(biz.email, "wrong");
    expect((await post(biz.email, "Password123!")).status).toBe(200);
    for (let i = 0; i < 4; i++) await post(biz.email, "wrong");
    expect((await post(biz.email, "Password123!")).status).toBe(200);
  });

  async function enrol() {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    const setup = await owner.post("/api/auth/mfa/setup").send({});
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toContain("otpauth://totp/");
    const code = totpAt(setup.body.secret, Math.floor(Date.now() / 30_000));
    const enable = await owner.post("/api/auth/mfa/enable").send({ code });
    expect(enable.status).toBe(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);
    return { biz, owner, secret: setup.body.secret as string, recovery: enable.body.recoveryCodes as string[] };
  }

  it("requires the second factor once enrolled; a code works once; recovery codes work once; secrets are encrypted", async () => {
    const { biz, secret, recovery } = await enrol();
    const noCode = await post(biz.email, "Password123!");
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe("mfa_required");
    expect(noCode.headers["set-cookie"]).toBeUndefined(); // no session until the second factor passes
    expect((await post(biz.email, "Password123!", "000000")).status).toBe(401);
    // the code used to enrol is already spent; use the next step
    const next = totpAt(secret, Math.floor(Date.now() / 30_000) + 1);
    expect((await post(biz.email, "Password123!", next)).status).toBe(200);
    expect((await post(biz.email, "Password123!", next)).status).toBe(401); // replay refused
    expect((await post(biz.email, "Password123!", recovery[0])).status).toBe(200);
    expect((await post(biz.email, "Password123!", recovery[0])).status).toBe(401); // single use
    const stored = await User.findOne({ email: biz.email }).select("+mfa.secretCipher +mfa.recoveryHashes");
    expect(stored!.mfa!.secretCipher).not.toContain(secret);
    expect(JSON.stringify(stored!.mfa!.recoveryHashes)).not.toContain(recovery[1]);
  });

  it("refuses to enrol without the server key, and refuses a wrong confirmation code", async () => {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    delete process.env.TELEPHONY_SECRET_KEY;
    expect((await owner.post("/api/auth/mfa/setup").send({})).status).toBe(503);
    process.env.TELEPHONY_SECRET_KEY = "k".repeat(40);
    await owner.post("/api/auth/mfa/setup").send({});
    expect((await owner.post("/api/auth/mfa/enable").send({ code: "123456" })).status).toBe(400);
    expect((await User.findOne({ email: biz.email }))!.mfa!.enabled).toBe(false);
  });

  it("when the business requires it, owners/admins are blocked from everything but setup until enrolled", async () => {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    expect((await owner.put("/api/security/settings").send({ requireMfa: true })).status).toBe(200);
    const blocked = await owner.get("/api/calls");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("mfa_setup_required");
    expect((await owner.get("/api/auth/me")).body.mfa).toEqual({ enabled: false, setupRequired: true });
    const setup = await owner.post("/api/auth/mfa/setup").send({});
    await owner.post("/api/auth/mfa/enable").send({ code: totpAt(setup.body.secret, Math.floor(Date.now() / 30_000)) });
    expect((await owner.get("/api/calls")).status).toBe(200);
    // and it can no longer be switched off by the people it protects
    const next = totpAt(setup.body.secret, Math.floor(Date.now() / 30_000) + 1);
    expect((await owner.post("/api/auth/mfa/disable").send({ password: "Password123!", code: next })).status).toBe(403);
  });
});

describe("Security & Privacy overview", () => {
  it("shows only this business's users, logins and recording access, masks emails, and is closed to staff", async () => {
    const a = await withRecording({ name: "Alpha Inn" });
    const b = await withRecording({ name: "Beta Lodge" });
    const { url } = (await a.owner.post(`/api/recordings/${a.rec!.recordingId}/link`).send({})).body;
    await a.owner.get(url);
    await makeClient().post("/api/auth/login").send({ email: a.biz.email, password: "bad" });
    const res = await a.owner.get("/api/security");
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].email).toMatch(/•••@/);
    expect(res.body.failedLogins24h).toBe(1);
    expect(res.body.recordingAccess.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(["recording.played", "recording.link_issued"]));
    expect(JSON.stringify(res.body)).not.toContain(b.rec!.recordingId);
    expect(res.body.backups.status).toBe("unknown"); // never assumed healthy
    const staff = await staffOf(a.biz, a.owner);
    expect((await staff.get("/api/security")).status).toBe(403);
  });
});
