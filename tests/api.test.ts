import { describe, expect, it } from "vitest";
import { makeClient } from "./client";
import { Call, FollowUp, Opportunity } from "../server/models";
import { login, makeBusiness, newCallSid, request } from "./helpers";
import { appendTranscript, createCallSession } from "../server/services/calls/callService";
import { runTool } from "../server/tools/registry";

async function callWithData(biz: Awaited<ReturnType<typeof makeBusiness>>) {
  const call = await createCallSession({
    businessId: biz.business._id, provider: "twilio", providerCallId: newCallSid(), callerNumber: "+15551230000",
    businessNumber: biz.config.twilioNumber!, routingReason: "no_answer", status: "ai_answered",
  });
  const ctx = { businessId: biz.business._id, callId: call._id };
  await runTool("create_booking_or_lead", ctx, { type: "booking", customerName: "Ana", details: "2 nights", estimatedValue: 300 });
  await runTool("create_follow_up", ctx, { reason: "Confirm booking" });
  return call;
}

describe("authentication", () => {
  it("signs up, sets an httpOnly cookie, and returns the session", async () => {
    const agent = makeClient();
    const res = await agent.post("/api/auth/signup").send({ name: "Sam", email: "sam@new.dev", password: "Password123!", businessName: "Sam's Salon", businessType: "salon_spa" });
    expect(res.status).toBe(201);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/i);
    expect((await agent.get("/api/auth/me")).body.user).toMatchObject({ email: "sam@new.dev", role: "owner" });
    await agent.post("/api/auth/logout");
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("rejects weak passwords, duplicate emails and bad logins", async () => {
    const biz = await makeBusiness();
    expect((await request().post("/api/auth/signup").send({ name: "A", email: "a@b.co", password: "short", businessName: "X" })).status).toBe(400);
    expect((await request().post("/api/auth/signup").send({ name: "A", email: biz.email, password: "Password123!", businessName: "X" })).status).toBe(409);
    expect((await request().post("/api/auth/login").send({ email: biz.email, password: "wrong-password" })).status).toBe(401);
    expect((await request().post("/api/auth/login").send({ email: "nobody@x.co", password: "whatever12" })).status).toBe(401);
  });

  it("requires authentication for dashboard APIs", async () => {
    for (const path of ["/api/calls", "/api/follow-ups", "/api/opportunities", "/api/dashboard", "/api/business", "/api/routing"]) {
      expect((await request().get(path)).status).toBe(401);
    }
  });
});

describe("business tenant isolation", () => {
  it("never lets one business read or modify another business's data", async () => {
    const a = await makeBusiness({ name: "Hotel A" });
    const b = await makeBusiness({ name: "Hotel B" });
    const callA = await callWithData(a);
    const fuA = (await FollowUp.findOne({ businessId: a.business._id }))!;
    const oppA = (await Opportunity.findOne({ businessId: a.business._id }))!;
    const asB = await login(b.email);

    // lists are empty for B
    expect((await asB.get("/api/calls")).body.calls).toHaveLength(0);
    expect((await asB.get("/api/follow-ups?status=all")).body.followUps).toHaveLength(0);
    expect((await asB.get("/api/opportunities")).body.opportunities).toHaveLength(0);
    expect((await asB.get("/api/dashboard")).body.metrics.callsReceived).toBe(0);

    // direct id access is a 404, not a 403 (don't confirm existence)
    expect((await asB.get(`/api/calls/${callA._id}`)).status).toBe(404);
    expect((await asB.delete(`/api/calls/${callA._id}`)).status).toBe(404);
    expect((await asB.patch(`/api/follow-ups/${fuA._id}`).send({ status: "completed" })).status).toBe(404);
    expect((await asB.patch(`/api/opportunities/${oppA._id}`).send({ status: "converted" })).status).toBe(404);
    expect((await asB.post("/api/follow-ups").send({ callId: String(callA._id), reason: "x" })).status).toBe(404);

    // A's data untouched
    expect((await FollowUp.findById(fuA._id))!.status).toBe("open");
    expect(await Call.countDocuments({ _id: callA._id })).toBe(1);

    // A still sees everything
    const asA = await login(a.email);
    expect((await asA.get(`/api/calls/${callA._id}`)).status).toBe(200);
  });

  it("cannot assign a follow-up to a user from another business", async () => {
    const a = await makeBusiness();
    const b = await makeBusiness();
    await callWithData(a);
    const fuA = (await FollowUp.findOne({ businessId: a.business._id }))!;
    const asA = await login(a.email);
    const res = await asA.patch(`/api/follow-ups/${fuA._id}`).send({ assignedTo: String(b.user._id) });
    expect(res.status).toBe(400);
  });

  it("agent tool endpoints derive the tenant from the call, not the request body", async () => {
    const a = await makeBusiness();
    const b = await makeBusiness();
    const callA = await callWithData(a);
    const res = await request()
      .post("/api/agent/follow-up")
      .set("x-agent-secret", "test-agent-secret")
      .send({ callId: String(callA._id), businessId: String(b.business._id), reason: "sneaky" });
    expect(res.body.ok).toBe(true);
    expect(await FollowUp.countDocuments({ businessId: b.business._id })).toBe(0); // body businessId ignored
    expect(await FollowUp.countDocuments({ businessId: a.business._id, reason: "sneaky" })).toBe(1);
  });

  it("agent tool endpoints reject missing or wrong secrets", async () => {
    const a = await makeBusiness();
    const callA = await callWithData(a);
    expect((await request().post("/api/agent/business-info").send({ callId: String(callA._id) })).status).toBe(401);
    expect((await request().post("/api/agent/business-info").set("x-agent-secret", "nope").send({ callId: String(callA._id) })).status).toBe(401);
  });
});

describe("follow-ups API", () => {
  it("lists, assigns, adds notes and completes; the call's flag follows", async () => {
    const biz = await makeBusiness();
    const call = await callWithData(biz);
    const agent = await login(biz.email);
    const list = await agent.get("/api/follow-ups");
    expect(list.body.followUps).toHaveLength(1);
    const id = list.body.followUps[0]._id;

    const assigned = await agent.patch(`/api/follow-ups/${id}`).send({ assignedTo: String(biz.user._id), note: "Called, left voicemail" });
    expect(assigned.body.followUp).toMatchObject({ status: "in_progress" });
    expect(assigned.body.followUp.notes[0]).toMatchObject({ text: "Called, left voicemail", authorName: "Owner" });

    const done = await agent.patch(`/api/follow-ups/${id}`).send({ status: "completed" });
    expect(done.body.followUp.completedAt).toBeTruthy();
    expect((await Call.findById(call._id))!.followUpRequired).toBe(false);

    expect((await agent.get("/api/follow-ups")).body.followUps).toHaveLength(0); // default view = active
    expect((await agent.get("/api/follow-ups?status=completed")).body.followUps).toHaveLength(1);
  });

  it("creates a manual follow-up", async () => {
    const biz = await makeBusiness();
    const agent = await login(biz.email);
    const res = await agent.post("/api/follow-ups").send({ customerName: "Walk-in", phone: "+15550001234", reason: "Send brochure", priority: "low" });
    expect(res.status).toBe(201);
    expect(res.body.followUp).toMatchObject({ status: "open", priority: "low" });
  });
});

describe("opportunities: verified revenue vs potential value", () => {
  it("only reports verified revenue once staff verify a converted opportunity", async () => {
    const biz = await makeBusiness();
    await callWithData(biz);
    const agent = await login(biz.email);
    const opp = (await agent.get("/api/opportunities")).body.opportunities[0];

    let dash = (await agent.get("/api/dashboard")).body.metrics;
    expect(dash).toMatchObject({ potentialOpportunityValue: 300, verifiedRevenue: 0 });

    // can't verify revenue on an opportunity that hasn't converted
    expect((await agent.patch(`/api/opportunities/${opp._id}`).send({ verifiedValue: 300 })).status).toBe(400);

    expect((await agent.patch(`/api/opportunities/${opp._id}`).send({ status: "converted", verifiedValue: 350 })).status).toBe(200);
    dash = (await agent.get("/api/dashboard")).body.metrics;
    expect(dash).toMatchObject({ potentialOpportunityValue: 0, verifiedRevenue: 350 });

    // moving it back invalidates the verified amount
    await agent.patch(`/api/opportunities/${opp._id}`).send({ status: "lost" });
    expect((await agent.get("/api/dashboard")).body.metrics.verifiedRevenue).toBe(0);
  });
});

describe("roles & privacy", () => {
  it("staff cannot change business settings, routing or delete calls; owners can", async () => {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    const created = await owner.post("/api/team").send({ name: "Stan", email: "stan@test.dev", password: "Password123!", role: "staff" });
    expect(created.status).toBe(201);
    const call = await callWithData(biz);

    const staff = await login("stan@test.dev");
    expect((await staff.get("/api/calls")).status).toBe(200);
    expect((await staff.patch("/api/business").send({ name: "Hacked" })).status).toBe(403);
    expect((await staff.patch("/api/routing").send({ aiOnly: true })).status).toBe(403);
    expect((await staff.delete(`/api/calls/${call._id}`)).status).toBe(403);
    expect((await owner.patch("/api/business").send({ name: "Renamed" })).body.business.name).toBe("Renamed");
  });

  it("recording is off by default and deleting a call removes its transcript", async () => {
    const biz = await makeBusiness();
    const owner = await login(biz.email);
    expect((await owner.get("/api/business")).body.business.privacy.recordingEnabled).toBe(false);

    const call = await callWithData(biz);
    await appendTranscript(call, "caller", "hello");
    expect((await owner.get(`/api/calls/${call._id}`)).body.transcript.segments).toHaveLength(1);
    expect((await owner.delete(`/api/calls/${call._id}/transcript`)).status).toBe(200);
    expect((await owner.get(`/api/calls/${call._id}`)).body.transcript).toBeNull();
    expect((await owner.delete(`/api/calls/${call._id}`)).status).toBe(200);
    expect((await owner.get(`/api/calls/${call._id}`)).status).toBe(404);
  });

  it("rejects a routing number already connected to another business", async () => {
    const a = await makeBusiness({ twilioNumber: "+15558880001" });
    const b = await makeBusiness();
    const asB = await login(b.email);
    expect((await asB.patch("/api/routing").send({ twilioNumber: "+1 (555) 888-0001" })).status).toBe(409);
    expect(a.config.twilioNumber).toBe("+15558880001");
  });
});

describe("test agent (simulator) — the MVP success scenario", () => {
  it("captures a service request, saves a summary and shows it to the owner", async () => {
    const biz = await makeBusiness();
    const agent = await login(biz.email);
    const start = await agent.post("/api/test-agent/sessions").send({});
    expect(start.status).toBe(201);
    const id = start.body.callId;

    const send = (text: string) => agent.post(`/api/test-agent/sessions/${id}/message`).send({ text });
    let r = await send("Hi, I'm in room 214 and the shower is not working");
    expect(r.body.call.actions.map((a: any) => a.tool)).toContain("create_service_request");
    r = await send("No, that's all. Goodbye");
    expect(r.body.ended).toBe(true);

    const detail = (await agent.get(`/api/calls/${id}`)).body;
    expect(detail.call).toMatchObject({ provider: "simulator", status: "completed", outcome: "service_request_created", intent: "service_request" });
    expect(detail.serviceRequests[0]).toMatchObject({ location: "room 214" });
    expect(detail.summary.summary).toBeTruthy();
    expect(detail.transcript.segments.length).toBeGreaterThan(4);
    expect((await agent.get("/api/calls?filter=all")).body.calls[0]._id).toBe(id);
  });
});

describe("agent chat API (text test mode)", () => {
  it("answers from business knowledge and reports intent + action, then continues the session", async () => {
    const biz = await makeBusiness();
    const agent = await login(biz.email);

    const hours = await agent.post("/api/agent/chat").send({ message: "What time do you close?" });
    expect(hours.status).toBe(200);
    expect(hours.body).toMatchObject({ intent: "business_hours", action: "get_business_info" });
    expect(hours.body.response).toContain("Monday");
    expect(hours.body.sessionId).toBeTruthy();

    const appt = await agent.post("/api/agent/chat").send({ message: "I need an appointment tomorrow", sessionId: hours.body.sessionId });
    expect(appt.body.intent).toBe("appointment_request");
    expect(appt.body.response).toMatch(/what time works best/i);
    expect(appt.body.action).toBe("collect_appointment_details");
  });

  it("requires a signed-in user and rejects other tenants' sessions", async () => {
    const a = await makeBusiness();
    const b = await makeBusiness();
    expect((await request().post("/api/agent/chat").send({ message: "hi" })).status).toBe(401);
    const asA = await login(a.email);
    const started = await asA.post("/api/agent/chat").send({ message: "hello" });
    const asB = await login(b.email);
    expect((await asB.post("/api/agent/chat").send({ message: "hi", sessionId: started.body.sessionId })).status).toBe(404);
  });
});

describe("health", () => {
  it("reports database connectivity", async () => {
    const res = await request().get("/api/health");
    expect(res.body).toEqual({ status: "ok", service: "StayDesk AI", database: "connected" });
  });
});
