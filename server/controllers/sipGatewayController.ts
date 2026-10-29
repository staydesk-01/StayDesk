import { z } from "zod";
import type { Request, Response } from "../http";
import { flags } from "../config/flags";
import { TelephonyConnection } from "../models";
import { verifySignature } from "../services/telephony/core/adapters/sipGateway";
import { applyEvent, routeIncoming } from "../services/telephony/core/sessions";
import { decryptSecret } from "../utils/secrets";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";

const phone = z.string().min(5).max(32);
const id = z.string().min(1).max(128);
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("incoming"), providerCallId: id, from: phone, to: phone }),
  z.object({ type: z.literal("status"), providerCallId: id, status: z.enum(["ringing", "answered", "in_progress", "completed", "failed", "no_answer", "busy", "canceled"]), reason: z.string().max(60).optional(), durationSeconds: z.number().min(0).max(86400).optional() }),
  z.object({ type: z.literal("dtmf"), providerCallId: id, digits: z.string().min(1).max(64) }),
  z.object({ type: z.literal("quality"), providerCallId: id, jitterMs: z.number().min(0).optional(), packetLossPct: z.number().min(0).max(100).optional(), rttMs: z.number().min(0).optional(), mos: z.number().min(1).max(5).optional() }),
  z.object({ type: z.literal("latency"), providerCallId: id, turnMs: z.number().min(0).max(120000) }),
  z.object({ type: z.literal("heartbeat"), activeCalls: z.number().int().min(0).optional() }),
]);
const body = z.object({ events: z.array(event).min(1).max(50) });

/**
 * POST /api/telephony/sip/events: signed events from the self-managed SIP gateway. The connection id selects the tenant
 * and the secret; the signature proves the gateway holds that secret. Answers one decision per `incoming` event.
 */
export async function sipEvents(req: Request, res: Response) {
  // Closed unless explicitly enabled: the endpoint does not even reveal that it exists.
  if (!flags.telephonyCore() || !flags.sipGateway()) throw AppError.notFound("Not found");
  const connectionId = req.header("x-staydesk-connection") ?? "";
  let conn;
  try { conn = await TelephonyConnection.findOne({ _id: toObjectId(connectionId), kind: "sip_gateway" }); } catch { conn = null; }
  const cipher = (conn?.secrets as Map<string, { cipher?: string }> | undefined)?.get("controlSecret")?.cipher;
  const secret = cipher ? decryptSecret(cipher) : undefined;
  if (!conn || !verifySignature(secret, req.header("x-staydesk-timestamp"), req.header("x-staydesk-signature"), req.rawBody ?? "")) throw AppError.unauthorized("Invalid gateway signature");

  const { events } = body.parse(req.body);
  const decisions: unknown[] = [];
  for (const e of events) {
    if (e.type === "incoming") decisions.push({ providerCallId: e.providerCallId, ...(await routeIncoming(conn.businessId, "sip_gateway", e)) });
    else await applyEvent(conn.businessId, "sip_gateway", e);
  }
  res.json({ ok: true, decisions });
}
