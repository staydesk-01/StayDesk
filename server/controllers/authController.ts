import bcrypt from "bcryptjs";
import type { Request, Response } from "../http";
import { env } from "../config/env";
import { AUTH_COOKIE, auth, signToken } from "../middleware/auth";
import { Business, User } from "../models";
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
  const { email, password } = loginBody.parse(req.body);
  const user = await User.findOne({ email }).select("+passwordHash");
  // Compare even when the user is missing so response time does not reveal which emails exist.
  const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali";
  const valid = await bcrypt.compare(password, hash);
  if (!user || !valid || !user.active) throw AppError.unauthorized("Incorrect email or password");
  res.cookie(AUTH_COOKIE, signToken(String(user._id)), cookieOptions);
  res.json(await userPayload(user));
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
