import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * Minimal supertest-style client that invokes the real Next.js route handlers in `app/api/**`
 * (same code path as production: adapter, auth, validation, controllers). No HTTP server needed.
 */
const API_ROOT = path.resolve(__dirname, "../app/api");

function resolveRoute(pathname: string): { file: string; params: Record<string, string> } {
  const segments = pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const params: Record<string, string> = {};
  let dir = API_ROOT;
  for (const seg of segments) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const exact = entries.find((e) => e.name === seg);
    const dynamic = entries.find((e) => /^\[[^\]]+\]$/.test(e.name));
    if (exact) dir = path.join(dir, exact.name);
    else if (dynamic) {
      params[dynamic.name.slice(1, -1)] = decodeURIComponent(seg);
      dir = path.join(dir, dynamic.name);
    } else throw new Error(`No route for ${pathname}`);
  }
  return { file: path.join(dir, "route.ts"), params };
}

export interface TestResponse {
  status: number;
   
  body: any;
  text: string;
  type: string;
  headers: Record<string, string | string[]>;
}

class Pending implements PromiseLike<TestResponse> {
  private headers: Record<string, string> = {};
  private payload: unknown;
  private form = false;
  constructor(
    private client: TestClient,
    private method: string,
    private url: string,
  ) {}
  set(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  type(t: string) {
    this.form = t === "form";
    return this;
  }
  send(body: unknown) {
    this.payload = body;
    return this;
  }
  then<A = TestResponse, B = never>(ok?: ((v: TestResponse) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.client.exec(this.method, this.url, this.headers, this.payload, this.form).then(ok, err);
  }
}

export class TestClient {
  private jar = new Map<string, string>();

  get = (url: string) => new Pending(this, "GET", url);
  post = (url: string) => new Pending(this, "POST", url);
  patch = (url: string) => new Pending(this, "PATCH", url);
  put = (url: string) => new Pending(this, "PUT", url);
  delete = (url: string) => new Pending(this, "DELETE", url);

  async exec(method: string, url: string, headers: Record<string, string>, payload: unknown, form: boolean): Promise<TestResponse> {
    const pathname = url.split("?")[0];
    const { file, params } = resolveRoute(pathname);
    const mod = await import(/* @vite-ignore */ file);
    const handler = mod[method];
    if (!handler) throw new Error(`${method} not implemented for ${pathname}`);

    const h: Record<string, string> = { ...headers };
    let body: string | undefined;
    if (payload !== undefined && method !== "GET") {
      if (form) {
        h["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(payload as Record<string, string>).toString();
      } else {
        h["content-type"] = "application/json";
        body = JSON.stringify(payload);
      }
    }
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");

    const request = new NextRequest(`http://localhost:3000${url}`, { method, headers: h, body });
    const res: Response = await handler(request, { params: Promise.resolve(params) });

    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const [pair] = c.split(";");
      const [name, ...rest] = pair.split("=");
      const value = rest.join("=");
      if (!value || /max-age=0/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON (TwiML) */
    }
    const outHeaders: Record<string, string | string[]> = {};
    res.headers.forEach((v, k) => (outHeaders[k] = v));
    if (setCookies.length) outHeaders["set-cookie"] = setCookies;
    return { status: res.status, body: json, text, type: res.headers.get("content-type") ?? "", headers: outHeaders };
  }
}

export const makeClient = () => new TestClient();
