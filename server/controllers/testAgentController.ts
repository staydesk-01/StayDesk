import { randomUUID } from "node:crypto";
import type { Request, Response } from "../http";
import { env } from "../config/env";
import { auth } from "../middleware/auth";
import { Business, BusinessKnowledge, Call, CallTranscript, PhoneConfiguration } from "../models";
import { agentEngine } from "../services/ai/agentEngine";
import { finalizeCall, createCallSession } from "../services/calls/callService";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";
import { normalizePhone } from "../utils/phone";
import { agentChatBody, testMessageBody, testSessionBody } from "../validators/api";

export async function testAgentStatus(req: Request, res: Response) {
  const { businessId } = auth(req);
  const [business, knowledge, config] = await Promise.all([
    Business.findById(businessId),
    BusinessKnowledge.findOne({ businessId }),
    PhoneConfiguration.findOne({ businessId }),
  ]);
  if (!business) throw AppError.notFound("Business not found");
  res.json({
    agentName: business.agentName,
    brain: agentEngine.brainName(), // "openai" | "rules"
    voiceLive: false, // browser speech is used for the test console; phone voice needs Twilio
    agentActive: config?.agentActive ?? true,
    knowledge: {
      loaded: !!knowledge && (!!knowledge.description || knowledge.faqs.length > 0 || knowledge.services.length > 0),
      faqs: knowledge?.faqs.length ?? 0,
      services: knowledge?.services.length ?? 0,
      hasHours: !!knowledge,
      hasPolicies: !!knowledge?.policies,
      hasPricing: !!knowledge?.pricingInfo,
    },
    integrations: { openai: !!env.OPENAI_API_KEY, twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN), email: !!env.RESEND_API_KEY },
  });
}

async function snapshot(callId: ReturnType<typeof toObjectId>, businessId: ReturnType<typeof toObjectId>) {
  const call = await Call.findOne({ _id: callId, businessId }).select("agentState actions intent status outcome transferStatus endedAt");
  const facts = (call?.agentState as { facts?: unknown } | undefined)?.facts;
  return call && { facts, intent: call.intent, status: call.status, outcome: call.outcome, transferStatus: call.transferStatus, actions: call.actions, endedAt: call.endedAt };
}

type SessionOptions = ReturnType<typeof testSessionBody.parse>;

/** Creates a simulated call (no phone involved): a normal Call record flagged provider "simulator". */
async function createSimulatorCall(businessId: ReturnType<typeof toObjectId>, body: SessionOptions) {
  const call = await createCallSession({
    businessId,
    provider: "simulator",
    providerCallId: `sim_${randomUUID()}`,
    callerNumber: normalizePhone(body.callerNumber),
    businessNumber: "test-console",
    routingReason: body.routingReason,
    handledBy: "ai",
    status: "ai_answered",
  });
  call.answeredAt = new Date();
  call.agentState = { simulateTransferAnswers: body.simulateTransferAnswers };
  await call.save();
  return call;
}

export async function startSession(req: Request, res: Response) {
  const { businessId } = auth(req);
  const call = await createSimulatorCall(businessId, testSessionBody.parse(req.body ?? {}));
  const greeting = await agentEngine.greet(call);
  res.status(201).json({ callId: String(call._id), greeting, brain: agentEngine.brainName() });
}

export async function sendMessage(req: Request, res: Response) {
  const { businessId } = auth(req);
  const { text, messageId } = testMessageBody.parse(req.body);
  const id = toObjectId(String(req.params.id));
  const call = await Call.findOne({ _id: id, businessId, provider: "simulator" });
  if (!call) throw AppError.notFound("Test session not found");
  if (call.endedAt) throw AppError.conflict("This test call has ended");

  const result = await agentEngine.respondWithStatus(call._id, text, { messageId });
  const ended = result.end || result.transfer;
  if (ended) await finalizeCall(call._id);
  res.json({ reply: result.reply, ended, messageId: result.messageId, responseId: result.responseId, duplicate: result.duplicate, call: await snapshot(id, businessId) });
}

export async function endSession(req: Request, res: Response) {
  const { businessId } = auth(req);
  const id = toObjectId(String(req.params.id));
  const call = await Call.findOne({ _id: id, businessId, provider: "simulator" });
  if (!call) throw AppError.notFound("Test session not found");
  await finalizeCall(call._id);
  const transcript = await CallTranscript.findOne({ callId: id, businessId });
  res.json({ call: await snapshot(id, businessId), callId: String(id), transcriptSegments: transcript?.segments.length ?? 0 });
}

/**
 * POST /api/agent/chat { message, sessionId? } -> { response, intent, action, sessionId }.
 * One-call text test of the agent: starts a session on the first message, then continues it with `sessionId`.
 */
export async function agentChat(req: Request, res: Response) {
  const { businessId } = auth(req);
  const { message, sessionId, messageId } = agentChatBody.parse(req.body ?? {});

  let call = sessionId ? await Call.findOne({ _id: toObjectId(sessionId), businessId, provider: "simulator" }) : null;
  if (sessionId && !call) throw AppError.notFound("Test session not found");
  if (call?.endedAt) throw AppError.conflict("This test conversation has ended. Start a new one without sessionId.");
  if (!call) {
    call = await createSimulatorCall(businessId, testSessionBody.parse({}));
    await agentEngine.greet(call);
  }

  const before = call.actions.length;
  const result = await agentEngine.respondWithStatus(call._id, message, { messageId });
  const ended = result.end || result.transfer;
  if (ended) await finalizeCall(call._id);

  const after = await Call.findById(call._id).select("actions agentState intent");
  const state = (after?.agentState ?? {}) as { awaiting?: string; flow?: string };
  const newActions = after?.actions.slice(before) ?? [];
  const action =
    newActions.at(-1)?.tool ??
    (state.awaiting && ["details", "name", "location"].includes(state.awaiting) ? `collect_${state.flow ?? "request"}_details` : "answer_from_knowledge");

  res.json({ response: result.reply, intent: result.intent, action, actions: newActions.map((a) => a.tool), sessionId: String(call._id), ended, messageId: result.messageId, responseId: result.responseId, duplicate: result.duplicate });
}

/** Restores a test conversation after a page reload: the stored transcript (with stable ids) and the current state. */
export async function getSession(req: Request, res: Response) {
  const { businessId } = auth(req);
  const id = toObjectId(String(req.params.id));
  const call = await Call.findOne({ _id: id, businessId, provider: "simulator" }).select("_id endedAt");
  if (!call) throw AppError.notFound("Test session not found");
  const transcript = await CallTranscript.findOne({ callId: id, businessId });
  res.json({
    callId: String(id),
    ended: !!call.endedAt,
    segments: (transcript?.segments ?? []).filter((s) => s.role !== "tool").map((s) => ({ id: s.id ?? null, replyTo: s.replyTo ?? null, role: s.role, text: s.text, at: s.at })),
    call: await snapshot(id, businessId),
  });
}
