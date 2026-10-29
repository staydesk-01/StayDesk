import type { Types } from "mongoose";
import { logger } from "../../../config/logger";
import { TelephonyConnection, TelephonyHealthEvent } from "../../../models";
import type { ConnectionKind, ConnectionStatus } from "../../../models";
import { notify } from "../../notifications/notificationService";
import { breakers } from "./breaker";
import { getAdapter, loadContext } from "./registry";
import { TelephonyError } from "./types";

const DEGRADED_LATENCY_MS = Number(process.env.TELEPHONY_DEGRADED_LATENCY_MS) || 2000;
const OFFLINE_AFTER_FAILURES = 3;
export const STALE_AFTER_MS = 5 * 60_000;

export async function recordHealth(provider: string, kind: "check_ok" | "check_failed" | "breaker_open" | "breaker_closed" | "heartbeat" | "alert", detail: string, opts: { businessId?: Types.ObjectId; latencyMs?: number } = {}) {
  await TelephonyHealthEvent.create({ provider, kind, detail: detail.slice(0, 300), businessId: opts.businessId, latencyMs: opts.latencyMs }).catch((e) => logger.error("Could not record a health event", { message: (e as Error).message }));
}

/**
 * Checks one connection and updates its stored status:
 *  not_configured (nothing/invalid) → testing (never checked) → connected | degraded (slow or 1-2 failures) | offline (3+ failures).
 * "Connected" means the provider's control API answered. It does NOT prove a live phone call works end to end.
 */
export async function checkConnection(businessId: Types.ObjectId, kind: ConnectionKind): Promise<{ status: ConnectionStatus; reason: string }> {
  const conn = await TelephonyConnection.findOne({ businessId, kind });
  if (!conn) return { status: "not_configured", reason: "No connection has been added." };
  const adapter = getAdapter(kind);
  const { ctx } = await loadContext(businessId, kind);

  let problems: string[];
  try {
    problems = adapter.validate(ctx);
  } catch (e) {
    problems = [(e as Error).message];
  }
  if (problems.length) {
    conn.status = "not_configured";
    conn.statusReason = problems.join(" ");
    conn.lastCheckedAt = new Date();
    await conn.save();
    return { status: conn.status, reason: conn.statusReason };
  }
  if (!conn.lastCheckedAt) {
    conn.status = "testing";
    await conn.save();
  }

  const provider = `${kind}:${businessId}`;
  try {
    breakers.assertCallable(provider);
    const r = await adapter.checkHealth(ctx);
    breakers.success(provider);
    conn.consecutiveFailures = 0;
    conn.lastOkAt = new Date();
    conn.status = r.latencyMs > DEGRADED_LATENCY_MS ? "degraded" : "connected";
    conn.statusReason = r.latencyMs > DEGRADED_LATENCY_MS ? `Slow responses (${r.latencyMs} ms).` : r.detail;
    await recordHealth(kind, "check_ok", r.detail, { businessId, latencyMs: r.latencyMs });
  } catch (e) {
    const err = e as Error;
    if (!(e instanceof TelephonyError && e.code === "circuit_open")) breakers.failure(provider);
    const before = conn.status;
    conn.consecutiveFailures += 1;
    conn.status = conn.consecutiveFailures >= OFFLINE_AFTER_FAILURES ? "offline" : "degraded";
    conn.statusReason = err.message.slice(0, 200);
    await recordHealth(kind, "check_failed", err.message, { businessId });
    if (conn.status === "offline" && before !== "offline") {
      await recordHealth(kind, "alert", `${kind} is offline: ${err.message}`, { businessId });
      await notify({ businessId, type: "info", title: `Phone connection offline: ${kind}`, body: `${err.message}. Calls may not reach StayDesk until this is fixed.`, link: "/telephony" }).catch(() => undefined);
    }
  }
  conn.lastCheckedAt = new Date();
  await conn.save();
  return { status: conn.status, reason: conn.statusReason };
}

/** Status as shown to the user: a result older than STALE_AFTER_MS is not presented as current. */
export function effectiveStatus(conn: { status: ConnectionStatus; statusReason?: string | null; lastCheckedAt?: Date | null }, now = Date.now()): { status: ConnectionStatus; reason: string } {
  if (conn.status === "connected" && conn.lastCheckedAt && now - conn.lastCheckedAt.getTime() > STALE_AFTER_MS) return { status: "degraded", reason: "No recent health check. Re-test the connection." };
  return { status: conn.status, reason: conn.statusReason ?? "" };
}
