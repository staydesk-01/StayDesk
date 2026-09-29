import { describe, expect, it } from "vitest";
import { Call, FollowUp, Notification, Opportunity, ServiceRequest } from "../server/models";
import { createCallSession, finalizeCall } from "../server/services/calls/callService";
import { runTool } from "../server/tools/registry";
import { makeBusiness, newCallSid } from "./helpers";

async function liveCall(biz: Awaited<ReturnType<typeof makeBusiness>>, provider: "twilio" | "simulator" = "twilio") {
  const call = await createCallSession({
    businessId: biz.business._id, provider, providerCallId: newCallSid(), callerNumber: "+15551230000",
    businessNumber: biz.config.twilioNumber!, routingReason: "no_answer", status: "ai_answered",
  });
  return { call, ctx: { businessId: biz.business._id, callId: call._id } };
}

describe("create_booking_or_lead", () => {
  it("creates an opportunity, never claims revenue, and alerts the owner", async () => {
    const biz = await makeBusiness();
    const { call, ctx } = await liveCall(biz);
    const res = await runTool("create_booking_or_lead", ctx, { type: "booking", customerName: "Ana Diaz", details: "Deluxe King, 2 nights", estimatedValue: 400 });
    expect(res.ok).toBe(true);

    const opp = (await Opportunity.findOne({ callId: call._id }))!;
    expect(opp).toMatchObject({ type: "booking", customerName: "Ana Diaz", customerPhone: "+15551230000", estimatedValue: 400, status: "new" });
    expect(opp.verifiedValue).toBeUndefined(); // potential value only until staff verify it

    const types = (await Notification.find({ businessId: biz.business._id })).map((n) => n.type);
    expect(types).toContain("booking_inquiry");
    expect((await Call.findById(call._id))!.callerName).toBe("Ana Diaz");
    expect((await Call.findById(call._id))!.actions.map((a) => a.tool)).toContain("create_booking_or_lead");
  });

  it("raises a high-value alert above the business threshold", async () => {
    const biz = await makeBusiness();
    const { ctx } = await liveCall(biz);
    await runTool("create_booking_or_lead", ctx, { type: "sales_lead", customerName: "Big Corp", details: "Retreat for 40", estimatedValue: 5000 });
    const types = (await Notification.find({ businessId: biz.business._id })).map((n) => n.type);
    expect(types).toContain("high_value_lead");
  });

  it("rejects invalid input with a structured error and writes nothing", async () => {
    const biz = await makeBusiness();
    const { ctx } = await liveCall(biz);
    const res = await runTool("create_booking_or_lead", ctx, { type: "teleport", customerName: "", details: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "validation_error" } });
    expect(await Opportunity.countDocuments()).toBe(0);
  });
});

describe("create_follow_up", () => {
  it("creates a follow-up, flags the call, and alerts on callback requests", async () => {
    const biz = await makeBusiness();
    const { call, ctx } = await liveCall(biz);
    const res = await runTool("create_follow_up", ctx, { customerName: "Lee", reason: "Call me about group rates", priority: "high", type: "callback" });
    expect(res.ok).toBe(true);
    const fu = (await FollowUp.findOne({ callId: call._id }))!;
    expect(fu).toMatchObject({ status: "open", priority: "high", phone: "+15551230000", customerName: "Lee" });
    expect(fu.dueAt).toBeInstanceOf(Date);
    expect((await Call.findById(call._id))!.followUpRequired).toBe(true);
    expect((await Notification.find()).map((n) => n.type)).toContain("callback_requested");
  });
});

describe("create_follow_up de-duplication", () => {
  it("merges a callback into the follow-up already raised for this call instead of duplicating it", async () => {
    const biz = await makeBusiness();
    const { call, ctx } = await liveCall(biz, "simulator");
    call.agentState = { simulateTransferAnswers: false };
    await call.save();
    await runTool("request_human_transfer", ctx, {}); // unanswered -> automatic high-priority follow-up
    expect(await FollowUp.countDocuments({ callId: call._id })).toBe(1);

    const res = await runTool("create_follow_up", ctx, { customerName: "Pat Lee", reason: "Wants to discuss a reservation", type: "callback" });
    expect(res).toMatchObject({ ok: true, data: { merged: true } });

    const all = await FollowUp.find({ callId: call._id });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ customerName: "Pat Lee", priority: "high" });
    expect(all[0].notes.at(-1)?.text).toContain("Wants to discuss a reservation");
  });

  it("does not merge non-callback follow-ups", async () => {
    const biz = await makeBusiness();
    const { call, ctx } = await liveCall(biz);
    await runTool("create_follow_up", ctx, { reason: "Confirm booking" });
    await runTool("create_follow_up", ctx, { reason: "Send brochure" });
    expect(await FollowUp.countDocuments({ callId: call._id })).toBe(2);
  });
});

describe("create_service_request", () => {
  it("stores the request and alerts on urgent ones", async () => {
    const biz = await makeBusiness();
    const { ctx } = await liveCall(biz);
    await runTool("create_service_request", ctx, { category: "maintenance", description: "Water leak", location: "Room 12", urgency: "urgent" });
    expect(await ServiceRequest.findOne()).toMatchObject({ description: "Water leak", location: "Room 12", urgency: "urgent", status: "open" });
    expect((await Notification.find()).map((n) => n.type)).toContain("urgent_request");
  });
});

describe("tool security", () => {
  it("cannot act on another business's call (tenant isolation)", async () => {
    const a = await makeBusiness();
    const b = await makeBusiness();
    const { call } = await liveCall(a);
    // Business B's context + Business A's call id
    const res = await runTool("create_follow_up", { businessId: b.business._id, callId: call._id }, { reason: "leak attempt" });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await FollowUp.countDocuments()).toBe(0);
  });

  it("refuses to act after the call has ended", async () => {
    const biz = await makeBusiness();
    const { call, ctx } = await liveCall(biz);
    await finalizeCall(call._id);
    const res = await runTool("create_follow_up", ctx, { reason: "too late" });
    expect(res).toMatchObject({ ok: false, error: { code: "call_ended" } });
  });

  it("refuses when the agent is disabled for the business", async () => {
    const biz = await makeBusiness();
    const { ctx } = await liveCall(biz);
    biz.config.agentActive = false;
    await biz.config.save();
    expect(await runTool("create_follow_up", ctx, { reason: "x" })).toMatchObject({ ok: false, error: { code: "agent_disabled" } });
  });

  it("rejects unknown tools", async () => {
    const biz = await makeBusiness();
    const { ctx } = await liveCall(biz);
    expect(await runTool("drop_database", ctx, {})).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
  });

  it("get_business_info returns only verified knowledge", async () => {
    const biz = await makeBusiness();
    const { ctx } = await liveCall(biz);
    const res = await runTool("get_business_info", ctx, { topic: "faqs", query: "is there parking" });
    expect(res.ok && JSON.stringify(res.data)).toContain("Parking is $20 per night.");
  });

  it("check_availability never claims verified availability", async () => {
    const biz = await makeBusiness();
    const { ctx } = await liveCall(biz);
    const res = await runTool("check_availability", ctx, { date: "2026-12-01" });
    expect(res).toMatchObject({ ok: true, data: { verified: false, available: null } });
  });
});

describe("request_human_transfer", () => {
  it("starts a transfer on a real call and logs number/status/start time", async () => {
    const biz = await makeBusiness({ humanNumber: "+15557778888" });
    const { call, ctx } = await liveCall(biz);
    const res = await runTool("request_human_transfer", ctx, { reason: "wants a manager" });
    expect(res).toMatchObject({ ok: true, data: { status: "connecting" } });
    const c = (await Call.findById(call._id))!;
    expect(c).toMatchObject({ transferAttempted: true, transferStatus: "ringing", pendingTransfer: true });
    expect(c.transfer?.transferNumber).toBe("+15557778888");
    expect(c.transfer?.transferStartedAt).toBeInstanceOf(Date);
  });

  it("with no escalation number: reports unavailable and creates a follow-up + alert", async () => {
    const biz = await makeBusiness({ humanNumber: "" });
    biz.business.escalationPhone = "";
    await biz.business.save();
    const { call, ctx } = await liveCall(biz);
    const res = await runTool("request_human_transfer", ctx, {});
    expect(res).toMatchObject({ ok: true, data: { status: "unavailable" } });
    expect(await FollowUp.countDocuments({ callId: call._id, priority: "high" })).toBe(1);
    expect((await Call.findById(call._id))!.transferStatus).toBe("failed");
  });

  it("simulator: staff answers -> status answered", async () => {
    const biz = await makeBusiness();
    const { call, ctx } = await liveCall(biz, "simulator");
    call.agentState = { simulateTransferAnswers: true };
    await call.save();
    const res = await runTool("request_human_transfer", ctx, {});
    expect(res).toMatchObject({ ok: true, data: { status: "connected" } });
    const c = (await Call.findById(call._id))!;
    expect(c).toMatchObject({ transferStatus: "answered", handledBy: "ai_and_human", status: "human_transferred" });
    expect(c.transfer?.transferAnsweredAt).toBeInstanceOf(Date);
  });

  it("simulator: nobody answers -> follow-up and transfer_failed alert", async () => {
    const biz = await makeBusiness();
    const { call, ctx } = await liveCall(biz, "simulator");
    call.agentState = { simulateTransferAnswers: false };
    await call.save();
    const res = await runTool("request_human_transfer", ctx, {});
    expect(res).toMatchObject({ ok: true, data: { status: "no_answer" } });
    expect((await Call.findById(call._id))!.transferStatus).toBe("no_answer");
    expect(await FollowUp.countDocuments({ callId: call._id, priority: "high" })).toBe(1);
    expect((await Notification.find()).map((n) => n.type)).toContain("transfer_failed");
  });
});

describe("send_confirmation", () => {
  it("validates the destination and caps confirmations per call", async () => {
    const biz = await makeBusiness();
    const { ctx } = await liveCall(biz);
    expect(await runTool("send_confirmation", ctx, { channel: "email", to: "not-an-email", message: "hi" })).toMatchObject({ ok: false, error: { code: "validation_error" } });
    expect((await runTool("send_confirmation", ctx, { channel: "email", to: "a@b.co", message: "Got it" })).ok).toBe(true);
    expect((await runTool("send_confirmation", ctx, { channel: "email", to: "a@b.co", message: "Again" })).ok).toBe(true);
    expect(await runTool("send_confirmation", ctx, { channel: "email", to: "a@b.co", message: "Third" })).toMatchObject({ ok: false, error: { code: "limit_reached" } });
  });
});
