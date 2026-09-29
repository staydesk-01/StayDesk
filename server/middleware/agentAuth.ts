import crypto from "node:crypto";
import type { Request } from "../http";
import { env } from "../config/env";
import { Call } from "../models";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Authenticates calls from an external voice agent (Retell / Vapi / custom) to /api/agent/tool/*.
 * The tenant is derived from the Call record (`callId`), NEVER from a businessId in the request body,
 * so a compromised or confused agent cannot read or write another business's data.
 */
export async function authenticateAgent(req: Request): Promise<void> {
  const secret = env.AGENT_TOOL_SECRET;
  const provided = req.header("x-agent-secret") ?? "";
  if (!secret || !provided || !safeEqual(provided, secret)) throw AppError.unauthorized("Invalid agent credentials");

  const callId = req.body?.callId ?? req.body?.call_id;
  if (!callId) throw AppError.badRequest("callId is required");
  const call = await Call.findById(toObjectId(callId)).select("businessId");
  if (!call) throw AppError.notFound("Call not found");
  req.agent = { businessId: call.businessId, callId: call._id };
}
