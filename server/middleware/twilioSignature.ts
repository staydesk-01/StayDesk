import twilio from "twilio";
import { env } from "../config/env";
import { logger } from "../config/logger";
import type { Request } from "../http";
import { AppError } from "../utils/errors";

/**
 * Rejects any webhook not signed by Twilio with our auth token.
 * The signature covers the *public* URL Twilio called, so NEXT_PUBLIC_APP_URL (or PUBLIC_BASE_URL) must match
 * your ngrok / production URL exactly.
 */
export function verifyTwilioSignature(req: Request): void {
  if (env.TWILIO_SKIP_SIGNATURE) return;

  const token = env.TWILIO_AUTH_TOKEN;
  const signature = req.header("x-twilio-signature");
  if (!token || !signature) {
    logger.warn("Twilio webhook rejected: missing auth token or signature", { path: req.path });
    throw AppError.forbidden("Forbidden");
  }
  const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${req.originalUrl}`;
  if (!twilio.validateRequest(token, signature, url, (req.body ?? {}) as Record<string, string>)) {
    logger.warn("Twilio webhook rejected: invalid signature", { path: req.path });
    throw AppError.forbidden("Forbidden");
  }
}
