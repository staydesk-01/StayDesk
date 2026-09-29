import type { Handler, Request, Response } from "../http";
import { logger } from "../config/logger";
import { Call, CallTranscript } from "../models";
import { getVoiceProvider } from "../services/ai/voice";
import { appendTranscript, finalizeCall } from "../services/calls/callService";
import {
  TECH_DIFFICULTIES,
  handleDialResult,
  handleGather,
  handleIncoming,
  handleRecording,
  handleStatus,
  handleTransferResult,
} from "../services/calls/callFlow";
import { getTelephony } from "../services/telephony";
import type { CallInstruction } from "../services/telephony";
import { runTool } from "../tools/registry";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * Runs a webhook handler and always answers with valid call-control markup.
 * If anything throws, the caller hears a polite message instead of Twilio's generic "application error".
 */
function callControl(fn: (req: Request) => Promise<CallInstruction>): Handler {
  return async (req, res) => {
    let instruction: CallInstruction;
    try {
      instruction = await fn(req);
    } catch (e) {
      logger.error(`Webhook ${req.path} failed`, { message: (e as Error).message, stack: (e as Error).stack });
      instruction = TECH_DIFFICULTIES;
    }
    res.status(200).type("text/xml").send(getTelephony().render(instruction));
  };
}

/** The callId in our own callback URLs must belong to the CallSid Twilio is reporting (defence in depth). */
async function assertSameCall(req: Request) {
  const callId = str(req.query.callId);
  const call = await Call.findById(toObjectId(callId)).select("providerCallId");
  if (!call || (req.body?.CallSid && call.providerCallId !== req.body.CallSid)) throw AppError.notFound("Unknown call");
  return callId;
}

export const incoming = callControl(async (req) => {
  const b = req.body ?? {};
  return handleIncoming({ callSid: str(b.CallSid), from: str(b.From), to: str(b.To) });
});

export const gather = callControl(async (req) => {
  const callId = await assertSameCall(req);
  return handleGather(callId, { speech: str(req.body?.SpeechResult) });
});

export const dialResult = callControl(async (req) => {
  const callId = await assertSameCall(req);
  return handleDialResult(callId, { dialStatus: str(req.body?.DialCallStatus), dialDuration: num(req.body?.DialCallDuration) });
});

export const transferResult = callControl(async (req) => {
  const callId = await assertSameCall(req);
  return handleTransferResult(callId, { dialStatus: str(req.body?.DialCallStatus) });
});

export async function status(req: Request, res: Response) {
  const b = req.body ?? {};
  try {
    await handleStatus({ callSid: str(b.CallSid), callStatus: str(b.CallStatus), duration: num(b.CallDuration) });
  } catch (e) {
    logger.error("Status webhook failed", { message: (e as Error).message });
  }
  res.sendStatus(204);
}

export async function recording(req: Request, res: Response) {
  const b = req.body ?? {};
  try {
    await handleRecording({ callSid: str(b.CallSid), url: str(b.RecordingUrl) || undefined, sid: str(b.RecordingSid) || undefined, duration: num(b.RecordingDuration) });
  } catch (e) {
    logger.error("Recording webhook failed", { message: (e as Error).message });
  }
  res.sendStatus(204);
}

/** Events from an external voice agent (Retell / Vapi): tool calls and end-of-call reports. */
export async function voiceProviderWebhook(req: Request, res: Response) {
  const provider = getVoiceProvider(String(req.params.provider));
  if (!provider) throw AppError.notFound("Unknown voice provider");
  if (!provider.verify(req)) throw AppError.unauthorized("Invalid webhook credentials");

  const results: unknown[] = [];
  for (const event of provider.parse(req.body)) {
    const call = await Call.findById(toObjectId(event.callRef)).select("businessId");
    if (!call) continue; // tenant is always derived from the Call, never from the payload
    if (event.type === "tool_call") {
      const result = await runTool(event.name, { businessId: call.businessId, callId: call._id }, event.args);
      results.push(provider.toolResponse(event, result));
    } else {
      const existing = await CallTranscript.exists({ callId: call._id });
      if (!existing) for (const s of event.transcript) await appendTranscript(call, s.role, s.text);
      await finalizeCall(call._id, { durationSeconds: event.durationSeconds });
    }
  }
  // Providers expect one response object per tool-call webhook.
  res.json(results.length === 1 ? results[0] : results.length ? { results } : { ok: true });
}
