import type { Types } from "mongoose";
import { NextResponse, type NextRequest } from "next/server";
import { dbConnect } from "../lib/mongodb";
import { env } from "./config/env";
import { authenticateAgent } from "./middleware/agentAuth";
import { authenticate, requireRole } from "./middleware/auth";
import { toErrorResponse } from "./middleware/error";
import { verifyTwilioSignature } from "./middleware/twilioSignature";
import type { Role } from "./models/enums";
import { maybePurgeExpiredTranscripts } from "./services/retentionService";
import { AppError } from "./utils/errors";

/**
 * Tiny request/response contract the controllers are written against. `route()` below adapts a Next.js
 * Route Handler to it, so the whole API runs inside the single Next.js app (no Express, no second port).
 */
export interface Request {
  method: string;
  path: string;
  originalUrl: string;
  ip: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
   
  body: any;
  /** Exact request body text (needed to verify webhook signatures). */
  rawBody?: string;
  query: Record<string, string>;
  params: Record<string, string>;
  header(name: string): string | undefined;
  /** Set by authenticate(): the signed-in user + tenant. */
  auth?: { userId: string; businessId: Types.ObjectId; role: Role; name: string; email: string };
  /** Set by authenticateAgent(): tenant derived from the call, never from the request body. */
  agent?: { businessId: Types.ObjectId; callId: Types.ObjectId };
}

export interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  secure?: boolean;
  path?: string;
  /** milliseconds (Express convention) */
  maxAge?: number;
}

export interface Response {
  status(code: number): Response;
  json(body: unknown): Response;
  send(body: string): Response;
  sendStatus(code: number): Response;
  type(contentType: string): Response;
  cookie(name: string, value: string, options?: CookieOptions): Response;
  clearCookie(name: string, options?: CookieOptions): Response;
}

class ResponseBuilder implements Response {
  code = 200;
  contentType = "application/json";
  payload: string | null = null;
  cookies: { name: string; value: string; options: CookieOptions }[] = [];
  sent = false;

  status(code: number) {
    this.code = code;
    return this;
  }
  type(t: string) {
    this.contentType = t === "text/xml" ? "text/xml; charset=utf-8" : t;
    return this;
  }
  json(body: unknown) {
    this.contentType = "application/json";
    this.payload = JSON.stringify(body);
    this.sent = true;
    return this;
  }
  send(body: string) {
    this.payload = body;
    this.sent = true;
    return this;
  }
  sendStatus(code: number) {
    this.code = code;
    this.payload = null;
    this.sent = true;
    return this;
  }
  cookie(name: string, value: string, options: CookieOptions = {}) {
    this.cookies.push({ name, value, options });
    return this;
  }
  clearCookie(name: string, options: CookieOptions = {}) {
    this.cookies.push({ name, value: "", options: { ...options, maxAge: 0 } });
    return this;
  }
  toNextResponse() {
    const noBody = this.payload === null || this.code === 204;
    const res = new NextResponse(noBody ? null : this.payload, { status: this.code, headers: noBody ? {} : { "content-type": this.contentType } });
    for (const c of this.cookies) {
      res.cookies.set(c.name, c.value, {
        httpOnly: c.options.httpOnly,
        sameSite: c.options.sameSite,
        secure: c.options.secure,
        path: c.options.path ?? "/",
        maxAge: c.options.maxAge === undefined ? undefined : Math.floor(c.options.maxAge / 1000),
      });
    }
    res.headers.set("cache-control", "no-store");
    return res;
  }
}

// ---- rate limiting (in-memory, per instance) -------------------------------------
const LIMITS = { auth: { windowMs: 15 * 60_000, max: 30 }, api: { windowMs: 60_000, max: 300 }, webhook: { windowMs: 60_000, max: 600 } } as const;
type Bucket = keyof typeof LIMITS;
const hits = new Map<string, { count: number; reset: number }>();

function rateLimit(bucket: Bucket | undefined, ip: string) {
  if (!bucket || env.isTest) return;
  const { windowMs, max } = LIMITS[bucket];
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const entry = hits.get(key);
  if (!entry || entry.reset < now) {
    hits.set(key, { count: 1, reset: now + windowMs });
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return;
  }
  if (++entry.count > max) throw new AppError(429, bucket === "auth" ? "Too many attempts. Try again in a few minutes." : "Too many requests", "rate_limited");
}

async function buildRequest(request: NextRequest, params: Record<string, string>): Promise<Request> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const cookies: Record<string, string> = {};
  request.cookies.getAll().forEach((c) => (cookies[c.name] = c.value));

   
  let body: any = {};
  let rawBody = "";
  if (!["GET", "HEAD", "DELETE"].includes(request.method)) {
    const type = headers["content-type"] ?? "";
    const text = await request.text();
    rawBody = text;
    if (text) {
      if (type.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(text));
      else {
        try {
          body = JSON.parse(text);
        } catch {
          throw new AppError(400, "Malformed JSON body", "bad_json");
        }
      }
    }
  }

  return {
    method: request.method,
    path: url.pathname,
    originalUrl: url.pathname + url.search,
    ip: (headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "local",
    headers,
    cookies,
    body,
    rawBody,
    query: Object.fromEntries(url.searchParams),
    params,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

export type Handler = (req: Request, res: Response) => Promise<void> | void;

export interface RouteOptions {
  /** Require a signed-in user (session cookie). */
  auth?: boolean;
  /** With auth: restrict to these roles. */
  roles?: Role[];
  /** Require the shared agent secret; tenant is derived from `callId`. */
  agent?: boolean;
  /** Verify the X-Twilio-Signature header. */
  twilio?: boolean;
  limit?: Bucket;
}

type Ctx = { params?: Promise<Record<string, string | string[]>> };

/** Wraps a controller as a Next.js Route Handler: DB connect, rate limit, auth, error handling. */
export function route(handler: Handler, opts: RouteOptions = {}) {
  return async (request: NextRequest, ctx?: Ctx): Promise<NextResponse> => {
    const res = new ResponseBuilder();
    try {
      await dbConnect();
      maybePurgeExpiredTranscripts();
      const rawParams = (await ctx?.params) ?? {};
      const params = Object.fromEntries(Object.entries(rawParams).map(([k, v]) => [k, Array.isArray(v) ? v.join("/") : v]));
      const req = await buildRequest(request, params);

      rateLimit(opts.limit ?? (opts.twilio || opts.agent ? "webhook" : opts.auth ? "api" : undefined), req.ip);
      if (opts.twilio) verifyTwilioSignature(req);
      if (opts.agent) await authenticateAgent(req);
      if (opts.auth) {
        await authenticate(req);
        if (opts.roles) requireRole(...opts.roles)(req);
      }
      await handler(req, res);
      if (!res.sent) res.sendStatus(204);
    } catch (e) {
      const { status, body } = toErrorResponse(e, request.method, new URL(request.url).pathname);
      return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
    }
    return res.toNextResponse();
  };
}
