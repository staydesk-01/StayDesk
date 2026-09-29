import { env } from "./env";

const SENSITIVE = /(authorization|token|secret|password|api[-_]?key|cookie|signature)/i;

/** Recursively masks values whose key looks sensitive so secrets never reach logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";
function log(level: Level, msg: string, meta?: unknown) {
  if (env.isTest && level !== "error") return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta === undefined) fn(line);
  else fn(line, JSON.stringify(redact(meta)));
}

export const logger = {
  debug: (m: string, meta?: unknown) => log("debug", m, meta),
  info: (m: string, meta?: unknown) => log("info", m, meta),
  warn: (m: string, meta?: unknown) => log("warn", m, meta),
  error: (m: string, meta?: unknown) => log("error", m, meta),
};
