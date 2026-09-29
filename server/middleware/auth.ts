import type { Request } from "../http";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User } from "../models";
import type { Role } from "../models";
import { AppError } from "../utils/errors";

export const AUTH_COOKIE = "sd_token";

export function signToken(userId: string, expiresIn = env.JWT_EXPIRES_IN): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: expiresIn as jwt.SignOptions["expiresIn"] });
}

export function verifyToken(token: string): { sub: string } {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (typeof payload === "string" || !payload.sub) throw AppError.unauthorized();
  return { sub: String(payload.sub) };
}

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return req.cookies?.[AUTH_COOKIE];
}

/**
 * Resolves the signed-in user and attaches tenant context (businessId) to the request.
 * This is the single swap point if authentication moves to Clerk: verify the Clerk session
 * here and map it to a User document via `clerkId`.
 */
export async function authenticate(req: Request): Promise<void> {
  const token = extractToken(req);
  if (!token) throw AppError.unauthorized();
  let sub: string;
  try {
    sub = verifyToken(token).sub;
  } catch {
    throw AppError.unauthorized("Session expired. Please sign in again.");
  }
  const user = await User.findById(sub);
  if (!user || !user.active) throw AppError.unauthorized();
  req.auth = {
    userId: String(user._id),
    businessId: user.businessId,
    role: user.role as Role,
    name: user.name,
    email: user.email,
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request): void => {
    if (!req.auth) throw AppError.unauthorized();
    if (!roles.includes(req.auth.role)) throw AppError.forbidden();
  };
}

/** Typed accessor so controllers never touch `req.auth?` optionals. */
export function auth(req: Request) {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}
