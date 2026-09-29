"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, BadgeDollarSign, Clock, ListChecks, Play, PhoneIncoming, PhoneMissed, Sparkles, Target, UserRoundCheck, Info } from "lucide-react";
import { Dot, PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { ActivityChart } from "@/components/overview/activity-chart";
import { RecentCalls } from "@/components/overview/recent-calls";
import { VoiceAgentCard } from "@/components/overview/voice-agent-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/hooks/use-api";
import { formatDuration, formatMoney } from "@/lib/format";
import type { DashboardMetrics, RoutingResponse } from "@/types";

const DEFAULT_METRICS: DashboardMetrics["metrics"] = {
  callsReceived: 0, aiOverflowCalls: 0, opportunitiesCaptured: 0, needsFollowUp: 0, averageCallSeconds: 0,
  humanTransfers: 0, callsAbandoned: 0, answeredByStaff: 0, potentialOpportunityValue: 0, verifiedRevenue: 0,
};

const RANGES = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];
const rangeText = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days" } as const;

export default function OverviewPage() {
  const [range, setRange] = React.useState<DashboardMetrics["range"]>("7d");
  const { data, error, loading, refetch } = useApi<DashboardMetrics>(`/dashboard?range=${range}`, {
    events: ["call.created", "call.updated", "followup.updated", "opportunity.updated"],
    refreshMs: 30_000,
  });
  const routing = useApi<RoutingResponse>("/routing");
  const agent = useApi<{ knowledge: { loaded: boolean }; agentName: string }>("/test-agent/status");

  const failed = !!error && !data; // show zeros + a warning instead of blocking the page
  const m = data?.metrics ?? (failed ? DEFAULT_METRICS : undefined);
  const setupDone = !!agent.data?.knowledge.loaded && !!routing.data?.status.phoneConnected;
  const showSetup = !!agent.data && !!routing.data && !setupDone;

  return (
    <>
      <PageHeader
        eyebrow="Your business, always within reach"
        title={<>Every call counts<Dot /></>}
        description="Good conversations. Clear next steps. A little less on your plate."
        actions={
          <Button asChild size="lg">
            <Link href="/test-agent">
              <Play className="fill-current" /> Test your agent <ArrowUpRight />
            </Link>
          </Button>
        }
      />

      {data?.isDemo && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-warning/25 bg-warning-soft px-5 py-4 text-sm text-warning" role="note">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-bold">Sample data.</span> You’re looking at the demo business (Sunrise Boutique Hotel). Calls, opportunities and revenue shown are illustrative. Run a test call or connect a number to generate real records.
          </p>
        </div>
      )}

      {showSetup && (
        <div className="mb-8 flex flex-col gap-4 rounded-2xl border border-brand-200 bg-brand-100/60 p-5 sm:flex-row sm:items-center sm:p-6">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-surface shadow-card">
            <Sparkles className="size-6 text-brand-600" />
          </span>
          <div className="flex-1">
            <p className="text-base font-bold">Meet your newest team member.</p>
            <p className="mt-0.5 text-sm text-muted">Add your business knowledge, try a conversation, and connect your phone when you’re ready.</p>
          </div>
          <Link href="/business-knowledge" className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:underline">
            Set up your business <ArrowRight className="size-4" />
          </Link>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold">At a glance</h2>
          <Badge tone="neutral">All activity</Badge>
        </div>
        <Select value={range} onValueChange={(v) => setRange(v as DashboardMetrics["range"])} options={RANGES} className="w-44" aria-label="Date range" />
      </div>

      {failed && (
        <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-warning/25 bg-warning-soft px-5 py-4 text-sm text-warning">
          <Info className="size-4 shrink-0" />
          <p className="flex-1"><span className="font-bold">Unable to load dashboard data.</span> Showing zeros for now.{process.env.NODE_ENV !== "production" && <> Development detail: {error}</>}</p>
          <Button size="sm" variant="outline" onClick={refetch}>Retry</Button>
        </div>
      )}
      {(
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard loading={loading} label="Calls received" value={m?.callsReceived} hint={`Across your line ${rangeText[range]}`} icon={PhoneIncoming} />
            <StatCard loading={loading} label="AI overflow calls" value={m?.aiOverflowCalls} hint="Answered by StayDesk when staff couldn’t" icon={Sparkles} tone="brand" />
            <StatCard loading={loading} label="Opportunities captured" value={m?.opportunitiesCaptured} hint="Bookings, leads and service inquiries" icon={Target} tone="success" />
            <StatCard loading={loading} label="Needs follow-up" value={m?.needsFollowUp} hint="Open or in progress" icon={ListChecks} tone="warning" />
            <StatCard loading={loading} label="Average call length" value={m ? formatDuration(m.averageCallSeconds) : ""} hint="AI-handled conversations" icon={Clock} tone="info" />
            <StatCard loading={loading} label="Human transfers" value={m?.humanTransfers} hint="Callers connected to your team" icon={UserRoundCheck} tone="success" />
            <StatCard loading={loading} label="Calls abandoned" value={m?.callsAbandoned} hint="Hung up before anyone helped" icon={PhoneMissed} tone="danger" />
            <Card className="p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[15px] text-muted">Opportunity value</p>
                <span className="grid size-10 place-items-center rounded-xl bg-brand-100 text-brand-700"><BadgeDollarSign className="size-[18px]" /></span>
              </div>
              {loading || !m ? <Skeleton className="mt-5 h-10 w-28" /> : (
                <dl className="mt-3 space-y-3">
                  <div>
                    <dd className="text-[28px] leading-none font-extrabold tracking-tight">{formatMoney(m.potentialOpportunityValue)}</dd>
                    <dt className="mt-1 text-xs font-semibold text-muted">Potential Opportunity Value</dt>
                  </div>
                  <div className="border-t border-border pt-3">
                    <dd className="text-xl leading-none font-bold text-success">{formatMoney(m.verifiedRevenue)}</dd>
                    <dt className="mt-1 text-xs font-semibold text-muted">Verified Revenue</dt>
                  </div>
                </dl>
              )}
            </Card>
          </div>
          <p className="mt-3 px-1 text-xs text-muted">
            Potential value is an estimate from captured inquiries. <span className="font-semibold">Verified Revenue</span> only counts transactions your team has confirmed.
          </p>
        </>
      )}

      <div className="mt-8 grid gap-5 lg:grid-cols-[1fr_360px] xl:grid-cols-[1fr_400px]">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Conversation activity</CardTitle>
              <CardDescription>A clearer picture of when your callers need you.</CardDescription>
            </div>
            <span className="flex items-center gap-4 pt-1 text-xs text-muted">
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-brand-600" /> All calls</span>
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 border-t-2 border-dashed border-brand-400" /> AI handled</span>
            </span>
          </CardHeader>
          <CardContent>{loading ? <Skeleton className="h-64 w-full" /> : data ? <ActivityChart data={data.chart} /> : <p className="py-16 text-center text-sm text-muted">Activity will appear here once data loads.</p>}</CardContent>
        </Card>
        <VoiceAgentCard active={routing.data?.config.agentActive ?? true} phoneConnected={!!routing.data?.status.phoneConnected} agentName={agent.data?.agentName ?? "StayDesk"} />
      </div>

      <Card className="mt-5">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Recent calls</CardTitle>
            <CardDescription>The latest conversations, live as they happen.</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/calls">View all</Link>
          </Button>
        </CardHeader>
        <div className="pb-2">{loading ? <div className="space-y-3 p-6"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : <RecentCalls calls={data?.recentCalls ?? []} />}</div>
      </Card>
    </>
  );
}
