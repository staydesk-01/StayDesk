import crypto from "node:crypto";
import type { Types } from "mongoose";
import { LoginEvent } from "../../models";
import type { Request } from "../../http";

export const LOCK_WINDOW_MS = () => Number(process.env.LOGIN_LOCK_WINDOW_MS) || 15 * 60_000;
export const LOCK_THRESHOLD = () => Number(process.env.LOGIN_LOCK_THRESHOLD) || 5;
const FAILURES: ("bad_password" | "mfa_failed" | "inactive")[] = ["bad_password", "mfa_failed", "inactive"];

export async function recordLogin(req: Request, email: string, outcome: (typeof import("../../models").LOGIN_OUTCOMES)[number], who?: { userId?: Types.ObjectId; businessId?: Types.ObjectId }) {
  await LoginEvent.create({ email, outcome, ip: req.ip, userAgent: (req.header("user-agent") ?? "").slice(0, 200), ...who }).catch(() => undefined);
}

/** Failed attempts for this email since its last successful sign-in (within the lock window). Per email, so rotating IPs does not help an attacker. */
export async function recentFailures(email: string, now = Date.now()): Promise<number> {
  const since = new Date(now - LOCK_WINDOW_MS());
  const lastOk = await LoginEvent.findOne({ email, outcome: "success", createdAt: { $gte: since } }).sort({ createdAt: -1 }).select("createdAt");
  return LoginEvent.countDocuments({ email, outcome: { $in: FAILURES }, createdAt: { $gte: lastOk?.createdAt ?? since } });
}

export const hashRecoveryCode = (code: string) => crypto.createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
export const newRecoveryCodes = (n = 10) => Array.from({ length: n }, () => crypto.randomBytes(5).toString("hex"));
