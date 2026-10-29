import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { Business, Call, FollowUp, Opportunity, PaymentApproval } from "../models";
import { localDateKey, startOfLocalDay } from "../services/calls/businessHours";
import { AppError } from "../utils/errors";
import { dashboardQuery } from "../validators/api";

export async function getMetrics(req: Request, res: Response) {
  const { businessId } = auth(req);
  const { range } = dashboardQuery.parse(req.query);
  const business = await Business.findById(businessId);
  if (!business) throw AppError.notFound("Business not found");
  const tz = business.timezone;

  const now = new Date();
  const days = range === "30d" ? 30 : range === "7d" ? 7 : 1;
  const since = range === "today" ? startOfLocalDay(now, tz) : new Date(startOfLocalDay(now, tz).getTime() - (days - 1) * 86400_000);

  const pendingApprovalsQ = PaymentApproval.countDocuments({ businessId, status: "pending" });
  const [calls, opportunities, openFollowUps, recentCalls, pendingApprovals] = await Promise.all([
    Call.find({ businessId, startedAt: { $gte: since } }).select("startedAt handledBy status transferStatus durationSeconds endedAt provider isDemo outcome actions metrics completion voice").limit(10_000),
    Opportunity.find({ businessId, createdAt: { $gte: since } }).select("status estimatedValue verifiedValue"),
    FollowUp.countDocuments({ businessId, status: { $in: ["open", "in_progress"] } }),
    Call.find({ businessId }).sort({ startedAt: -1 }).limit(6).select("callerName callerNumber intent startedAt outcome status handledBy durationSeconds provider isDemo"),
    pendingApprovalsQ,
  ]);

  // Reliability block: REAL calls only. Test-console (simulator) calls and demo/seeded calls are excluded.
  const live = calls.filter((c) => c.provider !== "simulator" && !c.isDemo && c.handledBy !== "human");
  const sum = (f: (c: (typeof live)[number]) => number) => live.reduce((t, c) => t + f(c), 0);
  const toolCalls = sum((c) => c.metrics?.toolCalls ?? 0);
  const toolFailures = sum((c) => c.metrics?.toolFailures ?? 0);
  const turns = sum((c) => c.metrics?.turns ?? 0);
  const reliability = {
    liveCalls: live.length,
    resolvedByAi: live.filter((c) => c.transferStatus === "none" && c.outcome !== "failed" && c.outcome !== "abandoned" && c.outcome !== "follow_up_created").length,
    humanTransfers: live.filter((c) => c.transferStatus !== "none").length,
    reservationsConfirmed: live.filter((c) => c.outcome === "reservation_confirmed").length,
    toolCalls,
    toolSuccessRate: toolCalls ? Math.round(((toolCalls - toolFailures) / toolCalls) * 1000) / 10 : null,
    failedActions: toolFailures,
    incompleteActions: sum((c) => c.metrics?.incompleteActions ?? 0),
    avgAgentLatencyMs: turns ? Math.round(sum((c) => c.metrics?.totalLatencyMs ?? 0) / turns) : null,
    paymentApprovalsPending: pendingApprovals,
    /** From each call's stored completion record (calls ended before this existed have none and are not counted). */
    completion: {
      tracked: live.filter((c) => c.completion).length,
      fulfilled: live.filter((c) => (c.completion as { status?: string } | undefined)?.status === "fulfilled").length,
      answered: live.filter((c) => (c.completion as { status?: string } | undefined)?.status === "answered").length,
      needsFollowUp: live.filter((c) => (c.completion as { status?: string } | undefined)?.status === "needs_follow_up").length,
    },
    avgWebhookMs: sum((c) => c.voice?.turns ?? 0) ? Math.round(sum((c) => c.voice?.totalWebhookMs ?? 0) / sum((c) => c.voice?.turns ?? 0)) : null,
    recoveredErrors: sum((c) => c.voice?.recoveredErrors ?? 0),
  };

  const aiCalls = calls.filter((c) => c.handledBy !== "human");
  const ended = aiCalls.filter((c) => c.endedAt && c.durationSeconds > 0);
  const avg = ended.length ? Math.round(ended.reduce((s, c) => s + c.durationSeconds, 0) / ended.length) : 0;

  // Chart buckets: hourly for "today", otherwise one per local day.
  const buckets = new Map<string, { label: string; calls: number; aiHandled: number; abandoned: number }>();
  if (range === "today") {
    for (let h = 0; h < 24; h++) buckets.set(String(h).padStart(2, "0"), { label: `${h % 12 || 12}${h < 12 ? "a" : "p"}`, calls: 0, aiHandled: 0, abandoned: 0 });
  } else {
    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 86400_000 + 12 * 3600_000);
      const key = localDateKey(d, tz);
      buckets.set(key, { label: new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(d), calls: 0, aiHandled: 0, abandoned: 0 });
    }
  }
  for (const c of calls) {
    const key =
      range === "today"
        ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(c.startedAt)
        : localDateKey(c.startedAt, tz);
    const b = buckets.get(key);
    if (!b) continue;
    b.calls += 1;
    if (c.handledBy !== "human") b.aiHandled += 1;
    if (c.status === "abandoned") b.abandoned += 1;
  }

  res.json({
    range,
    since,
    isDemo: business.isDemo,
    metrics: {
      callsReceived: calls.length,
      aiOverflowCalls: aiCalls.length,
      opportunitiesCaptured: opportunities.length,
      needsFollowUp: openFollowUps,
      averageCallSeconds: avg,
      humanTransfers: calls.filter((c) => c.transferStatus === "answered").length,
      callsAbandoned: calls.filter((c) => c.status === "abandoned").length,
      answeredByStaff: calls.filter((c) => c.handledBy === "human").length,
      potentialOpportunityValue: opportunities.filter((o) => o.status === "new" || o.status === "contacted").reduce((s, o) => s + (o.estimatedValue ?? 0), 0),
      verifiedRevenue: opportunities.filter((o) => o.status === "converted" && o.verifiedValue != null).reduce((s, o) => s + (o.verifiedValue ?? 0), 0),
    },
    reliability,
    chart: [...buckets.values()],
    recentCalls,
  });
}
