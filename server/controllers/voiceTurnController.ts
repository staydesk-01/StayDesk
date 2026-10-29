import { z } from "zod";
import type { Request, Response } from "../http";
import { flags } from "../config/flags";
import { Call, CallSession, TelephonyConnection } from "../models";
import { verifySignature } from "../services/telephony/core/adapters/sipGateway";
import { runVoiceTurn } from "../services/voice/orchestrator";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";
import { decryptSecret } from "../utils/secrets";

const body = z.object({
  callId: z.string().regex(/^[a-f0-9]{24}$/i),
  messageId: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/),
  text: z.string().trim().min(1).max(1000),
  /** Optional measurement from the worker: ms from end of caller speech to first audio. */
  turnMs: z.number().min(0).max(120000).optional(),
});

/** POST /api/voice/turn: the voice worker asks the StayDesk agent what to say. Signed like the gateway events. */
export async function voiceTurn(req: Request, res: Response) {
  if (!flags.telephonyCore() || !flags.sipGateway()) throw AppError.notFound("Not found");
  let conn;
  try { conn = await TelephonyConnection.findOne({ _id: toObjectId(req.header("x-staydesk-connection")), kind: "sip_gateway" }); } catch { conn = null; }
  const cipher = (conn?.secrets as Map<string, { cipher?: string }> | undefined)?.get("controlSecret")?.cipher;
  if (!conn || !verifySignature(cipher ? decryptSecret(cipher) : undefined, req.header("x-staydesk-timestamp"), req.header("x-staydesk-signature"), req.rawBody ?? "")) throw AppError.unauthorized("Invalid worker signature");

  const b = body.parse(req.body);
  // Tenant guard: the worker may only speak for calls that belong to its own business and are still open.
  const call = await Call.findOne({ _id: toObjectId(b.callId), businessId: conn.businessId }).select("endedAt");
  if (!call) throw AppError.notFound("Call not found");
  if (call.endedAt) throw AppError.conflict("This call has ended");

  const out = await runVoiceTurn({ callId: b.callId, messageId: b.messageId, text: b.text });
  if (b.turnMs != null) await CallSession.updateOne({ businessId: conn.businessId, callId: call._id }, { $inc: { "latency.turns": 1, "latency.totalMs": b.turnMs }, $max: { "latency.maxMs": b.turnMs } });
  res.json(out);
}
