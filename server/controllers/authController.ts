import bcrypt from "bcryptjs";
import type { Request, Response } from "../http";
import { env } from "../config/env";
import { AUTH_COOKIE, auth, signToken } from "../middleware/auth";
import { Business, User } from "../models";
import { decryptSecret, encryptSecret, secretsConfigured } from "../utils/secrets";
import { newTotpSecret, otpauthUri, verifyTotp } from "../utils/totp";
import { LOCK_THRESHOLD, hashRecoveryCode, newRecoveryCodes, recentFailures, recordLogin } from "../services/security/loginGuard";
import { z } from "zod";
import type { UserDoc } from "../models";
import { audit } from "../services/auditService";
import { createBusinessWithOwner } from "../services/business/businessService";
import { AppError } from "../utils/errors";
import { loginBody, signupBody } from "../validators/api";

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.COOKIE_SECURE,
  path: "/",
  maxAge: 7 * 24 * 3600 * 1000,
};

async function userPayload(user: UserDoc) {
  const business = await Business.findById(user.businessId);
  return {
    user: { id: String(user._id), name: user.name, email: user.email, role: user.role },
    mfa: { enabled: !!user.mfa?.enabled, setupRequired: !user.mfa?.enabled && ["owner", "admin"].includes(user.role) && !!business?.security?.requireMfa },
    business: business && {
      id: String(business._id),
      name: business.name,
      type: business.type,
      onboardingComplete: business.onboardingComplete,
      isDemo: business.isDemo,
    },
  };
}

export async function signup(req: Request, res: Response) {
  const body = signupBody.parse(req.body);
  const { user, business } = await createBusinessWithOwner(body);
  await audit(req, business._id, "auth.signup", "user", user._id, undefined, { type: "user", id: String(user._id) });
  res.cookie(AUTH_COOKIE, signToken(String(user._id)), cookieOptions);
  res.status(201).json(await userPayload(user));
}

export async function login(req: Request, res: Response) {
  const { email, password, code } = loginBody.extend({ code: z.string().trim().max(32).optional() }).parse(req.body);
  if ((await recentFailures(email)) >= LOCK_THRESHOLD()) {
    await recordLogin(req, email, "locked");
    throw new AppError(429, "Too many failed sign-in attempts. Try again in 15 minutes.", "account_locked");
  }
  const user = await User.findOne({ email }).select("+passwordHash +mfa.secretCipher +mfa.recoveryHashes +mfa.lastUsedStep");
  // Compare even when the user is missing so response time does not reveal which emails exist.
  const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali";
  const valid = await bcrypt.compare(password, hash);
  const who = user ? { userId: user._id, businessId: user.businessId } : {};
  if (!user || !valid || !user.active) {
    await recordLogin(req, email, user && valid && !user.active ? "inactive" : "bad_password", who);
    throw AppError.unauthorized("Incorrect email or password");
  }
  if (user.mfa?.enabled) {
    if (!code) {
      await recordLogin(req, email, "mfa_required", who);
      throw new AppError(401, "Enter the 6-digit code from your authenticator app.", "mfa_required");
    }
    if (!(await consumeSecondFactor(user, code))) {
      await recordLogin(req, email, "mfa_failed", who);
      throw AppError.unauthorized("That code is not valid");
    }
  }
  await recordLogin(req, email, "success", who);
  res.cookie(AUTH_COOKIE, signToken(String(user._id)), cookieOptions);
  res.json(await userPayload(user));
}

/** A TOTP code (each time-step usable once) or a single-use recovery code. */
async function consumeSecondFactor(user: UserDoc, code: string): Promise<boolean> {
  if (/^\d{6}$/.test(code) && user.mfa?.secretCipher) {
    const step = verifyTotp(decryptSecret(user.mfa.secretCipher), code, user.mfa.lastUsedStep ?? 0);
    if (step === null) return false;
    // Conditional update: two simultaneous logins cannot both spend the same step.
    const r = await User.updateOne({ _id: user._id, "mfa.lastUsedStep": { $lt: step } }, { $set: { "mfa.lastUsedStep": step } });
    return r.modifiedCount === 1;
  }
  const h = hashRecoveryCode(code);
  const r = await User.updateOne({ _id: user._id, "mfa.recoveryHashes": h }, { $pull: { "mfa.recoveryHashes": h } });
  return r.modifiedCount === 1;
}

function requireKey() {
  if (!secretsConfigured()) throw new AppError(503, "Two-step sign-in needs TELEPHONY_SECRET_KEY (32+ characters) to be set on the server first.", "not_configured");
}

export async function mfaSetup(req: Request, res: Response) {
  requireKey();
  const a = auth(req);
  if (!["owner", "admin"].includes(a.role)) throw AppError.forbidden("Two-step sign-in is available to owners and admins");
  const user = await User.findById(a.userId);
  if (!user) throw AppError.unauthorized();
  if (user.mfa?.enabled) throw AppError.conflict("Two-step sign-in is already on");
  const secret = newTotpSecret();
  await User.updateOne({ _id: user._id }, { $set: { "mfa.pendingSecretCipher": encryptSecret(secret) } });
  res.json({ secret, otpauthUri: otpauthUri(secret, user.email) });
}

export async function mfaEnable(req: Request, res: Response) {
  requireKey();
  const a = auth(req);
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const user = await User.findById(a.userId).select("+mfa.pendingSecretCipher");
  if (!user?.mfa?.pendingSecretCipher) throw AppError.badRequest("Start setup first", "no_pending_setup");
  const secret = decryptSecret(user.mfa.pendingSecretCipher);
  const step = verifyTotp(secret, code);
  if (step === null) throw AppError.badRequest("That code is not valid. Check the time on your phone and try again.", "invalid_code");
  const recoveryCodes = newRecoveryCodes();
  await User.updateOne({ _id: user._id }, { $set: { "mfa.enabled": true, "mfa.secretCipher": encryptSecret(secret), "mfa.recoveryHashes": recoveryCodes.map(hashRecoveryCode), "mfa.lastUsedStep": step, "mfa.enrolledAt": new Date() }, $unset: { "mfa.pendingSecretCipher": 1 } });
  await audit(req, a.businessId, "auth.mfa_enabled", "user", a.userId);
  res.json({ ok: true, recoveryCodes }); // shown once; only hashes are kept
}

export async function mfaDisable(req: Request, res: Response) {
  const a = auth(req);
  const { password, code } = z.object({ password: z.string().min(1).max(128), code: z.string().trim().min(6).max(32) }).parse(req.body);
  const user = await User.findById(a.userId).select("+passwordHash +mfa.secretCipher +mfa.recoveryHashes +mfa.lastUsedStep");
  if (!user?.mfa?.enabled) throw AppError.badRequest("Two-step sign-in is not on");
  const biz = await Business.findById(a.businessId).select("security");
  if (biz?.security?.requireMfa) throw AppError.forbidden("Your business requires two-step sign-in for owners and admins");
  if (!(await bcrypt.compare(password, user.passwordHash)) || !(await consumeSecondFactor(user, code))) throw AppError.unauthorized("Password or code is not correct");
  await User.updateOne({ _id: user._id }, { $set: { "mfa.enabled": false, "mfa.recoveryHashes": [], "mfa.lastUsedStep": 0 }, $unset: { "mfa.secretCipher": 1 } });
  await audit(req, a.businessId, "auth.mfa_disabled", "user", a.userId);
  res.json({ ok: true });
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie(AUTH_COOKIE, { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
}

export async function me(req: Request, res: Response) {
  const user = await User.findById(auth(req).userId);
  if (!user) throw AppError.unauthorized();
  res.json(await userPayload(user));
}
