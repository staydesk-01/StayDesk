import { z } from "zod";
import type { QueryFilter } from "mongoose";
import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { Business, Call, CallSession, ConcurrencyGate } from "../models";
import { startOfLocalDay } from "../services/calls/businessHours";
import { maskPhone } from "../services/recordings/recordingService";
import { limitsFor } from "../services/telephony/concurrency/sessionManager";
import { checkTwilio } from "../services/telephony/twilioAccount";

const LIVE = ["incoming", "initializing", "active", "completing"] as const;
const query = z.object({
  scope: z.enum(["active", "recent"]).default("active"),
  status: z.enum(["all", "completed", "failed"]).default("all"),
  outcome: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const avg = (n: number, d: number) => (d ? Math.round(n / d) : null);

/** Live sessions + capacity for the signed-in business. Every number is computed from stored sessions and calls; none is estimated. */
export async function liveCalls(req: Request, res: Response) {
  const { businessId } = auth(req);
  const q = query.parse(req.query);
  const biz = await Business.findById(businessId).select("name timezone concurrency");
  const dayStart = startOfLocalDay(new Date(), biz?.timezone ?? "UTC");

  const where: QueryFilter<Record<string, unknown>> = { businessId };
  if (q.scope === "active") where.lifecycle = { $in: LIVE };
  else {
    where.startedAt = { $gte: q.from ?? new Date(Date.now() - 24 * 3600_000), ...(q.to && { $lte: q.to }) };
    if (q.status === "completed") where.lifecycle = "completed";
    if (q.status === "failed") where.lifecycle = "failed";
  }
  const [lim, gate, sessions, today] = await Promise.all([
    limitsFor(businessId, undefined, { carrier: false }),
    ConcurrencyGate.findOne({ businessId }),
    CallSession.find(where).sort({ startedAt: -1 }).limit(100),
    CallSession.find({ businessId, startedAt: { $gte: dayStart } }).select("lifecycle failureCause timings.setupMs durationSeconds callId"),
  ]);
  const calls = new Map((await Call.find({ _id: { $in: sessions.map((s) => s.callId).filter(Boolean) }, businessId }).select("callUuid callerNumber handledBy transferStatus transferAttempted outcome status recording voice metrics direction")).map((c) => [String(c._id), c]));

  // Averages over today's calls with measured data.
  const todayCalls = await Call.find({ _id: { $in: today.map((s) => s.callId).filter(Boolean) }, businessId }).select("voice.turns voice.totalWebhookMs metrics.turns metrics.totalLatencyMs");
  const wt = todayCalls.reduce((t, c) => t + (c.voice?.turns ?? 0), 0), wm = todayCalls.reduce((t, c) => t + (c.voice?.totalWebhookMs ?? 0), 0);
  const at = todayCalls.reduce((t, c) => t + (c.metrics?.turns ?? 0), 0), am = todayCalls.reduce((t, c) => t + (c.metrics?.totalLatencyMs ?? 0), 0);
  const setups = today.map((s) => s.timings?.setupMs).filter((n): n is number => typeof n === "number");
  const done = today.filter((s) => s.lifecycle === "completed" && (s.durationSeconds ?? 0) > 0);

  const rows = sessions
    .map((s) => {
      const c = s.callId ? calls.get(String(s.callId)) : undefined;
      return {
        sessionKey: s.sessionKey, callUuid: c?.callUuid, callId: s.callId ? String(s.callId) : undefined, business: biz?.name,
        phone: maskPhone(s.fromNumber), startedAt: s.startedAt, endedAt: s.endedAt, durationSeconds: s.endedAt ? s.durationSeconds : Math.round((Date.now() - s.startedAt.getTime()) / 1000),
        lifecycle: s.lifecycle, stage: s.stage, stageSince: s.stageAt, handledBy: c?.handledBy, direction: s.direction,
        handoff: c?.transferStatus && c.transferStatus !== "none" ? c.transferStatus : s.stage === "waiting_human" ? "ringing_human" : "none",
        recording: c?.recording?.recordingId ? "saved" : c?.recording?.enabled ? "recording" : "off",
        outcome: c?.outcome ?? "in_progress", failureCause: s.failureCause, configRef: s.configRef,
      };
    })
    .filter((r) => !q.outcome || r.outcome === q.outcome);

  res.json({
    capacity: {
      active: gate?.active ?? 0, limit: lim.limit, available: Math.max(0, lim.limit - (gate?.active ?? 0)), peak: gate?.peak ?? 0,
      receivedToday: today.length, avgDurationSeconds: avg(done.reduce((t, s) => t + (s.durationSeconds ?? 0), 0), done.length),
      failedToday: today.filter((s) => s.lifecycle === "failed" && !s.failureCause?.startsWith("overflow:")).length,
      overflowedToday: today.filter((s) => s.failureCause?.startsWith("overflow:")).length,
      queueEnabled: false, queueLength: 0,
      config: { targetConcurrentCalls: 10, maxConfiguredConcurrentCalls: lim.businessLimit, overflowBehavior: lim.policy === "callback" ? "controlled_fallback" : lim.policy, sessionIsolation: true },
      verified: false,
      verifiedNote: "The configured limit is a setting, not proof of capacity. Capacity counts as verified only after a recorded load test with your real Twilio account.",
    },
    latency: {
      sessionInitMs: avg(setups.reduce((a, b) => a + b, 0), setups.length),
      agentMs: avg(am, at),
      webhookRoundTripMs: avg(wm, wt),
      speechRecognitionMs: null, ttsMs: null, endToEndMs: null,
      note: "Speech recognition and speech synthesis run inside Twilio, which does not report their timing, so they and true end-to-end latency are not measured. Webhook round trip is TrulyHello's own processing time.",
    },
    scope: q.scope,
    sessions: rows,
  });
}

export async function twilioCheck(req: Request, res: Response) {
  res.json(await checkTwilio(auth(req).businessId));
}
