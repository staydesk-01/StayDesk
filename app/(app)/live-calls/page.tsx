"use client";
import * as React from "react";
import { RadioTower } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/format";

interface Row {
  sessionKey?: string; callUuid?: string; callId?: string; phone: string; startedAt: string; durationSeconds: number; lifecycle: string; stage: string;
  handledBy?: string; handoff: string; recording: string; outcome: string; failureCause?: string; direction: string;
}
interface Live {
  capacity: { active: number; limit: number; available: number; peak: number; receivedToday: number; avgDurationSeconds: number | null; failedToday: number; overflowedToday: number; queueEnabled: boolean; queueLength: number; config: { targetConcurrentCalls: number; maxConfiguredConcurrentCalls: number; overflowBehavior: string; sessionIsolation: boolean }; verified: boolean; verifiedNote: string };
  latency: { sessionInitMs: number | null; agentMs: number | null; webhookRoundTripMs: number | null; note: string };
  sessions: Row[];
}
interface TwilioCheck { status: string; accountType?: string; accountStatus?: string; number?: string; voiceUrlMatches?: boolean; warnings: string[]; checkedAt: string }

const STAGE: Record<string, { label: string; tone: BadgeTone }> = {
  incoming: { label: "Incoming", tone: "info" }, initializing: { label: "Initializing", tone: "info" }, listening: { label: "Listening", tone: "success" },
  processing: { label: "Processing", tone: "brand" }, executing_tool: { label: "Executing tool", tone: "brand" }, speaking: { label: "Speaking / listening", tone: "success" },
  waiting_human: { label: "Waiting for human", tone: "warning" }, transferring: { label: "Transferring", tone: "warning" }, completed: { label: "Completed", tone: "neutral" }, failed: { label: "Failed", tone: "danger" },
};
const ms = (n: number | null) => (n == null ? "not measured" : `${n} ms`);

export default function LiveCallsPage() {
  const { canManage } = useSession();
  const [scope, setScope] = React.useState<"active" | "recent">("active");
  const [status, setStatus] = React.useState<"all" | "completed" | "failed">("all");
  const { data, error, loading, refetch } = useApi<Live>(`/calls/live?scope=${scope}&status=${status}`, { events: ["call.created", "call.updated"], refreshMs: 3000 });
  const [check, setCheck] = React.useState<TwilioCheck | null>(null);
  const [checking, setChecking] = React.useState(false);
  async function runCheck() { setChecking(true); try { setCheck(await api<TwilioCheck>("/telephony/twilio-check")); } finally { setChecking(false); } }

  const c = data?.capacity;
  return (
    <>
      <PageHeader title="Live calls" description="Every call is its own isolated session. Figures come from stored sessions; anything not measured says so." />
      {c && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Active calls", `${c.active} / ${c.limit}`], ["Capacity available", c.available], ["Peak at once", c.peak], ["Received today", c.receivedToday],
            ["Avg call length", c.avgDurationSeconds == null ? "n/a" : formatDuration(c.avgDurationSeconds)], ["Failed today", c.failedToday], ["Overflowed today", c.overflowedToday], ["Queue", c.queueEnabled ? c.queueLength : "off"],
          ].map(([k, v]) => <Card key={String(k)}><CardContent className="py-4"><p className="text-2xl leading-none font-bold">{v}</p><p className="mt-1 text-xs font-semibold text-muted">{k}</p></CardContent></Card>)}
        </div>
      )}
      <Card className="mb-5">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div><CardTitle>Sessions</CardTitle><CardDescription>{scope === "active" ? "Calls in progress right now." : "Last 24 hours."}</CardDescription></div>
          <div className="flex flex-wrap gap-2">
            <Segmented label="Scope" value={scope} onChange={setScope} options={[{ value: "active", label: "Active" }, { value: "recent", label: "Recent" }]} />
            {scope === "recent" && <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: "all", label: "All" }, { value: "completed", label: "Completed" }, { value: "failed", label: "Failed" }]} />}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && !data ? <Skeleton className="m-5 h-40" /> : error && !data ? <ErrorState message={error} onRetry={refetch} /> : !data?.sessions.length ? (
            <EmptyState icon={RadioTower} title={scope === "active" ? "No calls right now" : "No sessions found"} description="Calls appear here the moment they arrive and update as they progress." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted"><tr><th className="px-5 py-2">Call</th><th>Caller</th><th>Started</th><th>Duration</th><th>Stage</th><th>Handled by</th><th>Handoff</th><th>Recording</th><th>Outcome</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {data.sessions.map((r) => {
                    const st = STAGE[r.stage] ?? { label: r.stage, tone: "neutral" as BadgeTone };
                    return (
                      <tr key={r.sessionKey ?? r.callId}>
                        <td className="px-5 py-3"><code title={r.callUuid}>{(r.callUuid ?? r.sessionKey ?? "").slice(0, 8)}</code></td>
                        <td>{r.phone}</td><td>{formatDateTime(r.startedAt)}</td><td>{formatDuration(r.durationSeconds)}</td>
                        <td><Badge tone={st.tone}>{st.label}</Badge>{r.failureCause && <span className="ml-1 text-xs text-muted">{r.failureCause.replace(/_/g, " ")}</span>}</td>
                        <td>{r.handledBy ?? "—"}</td><td>{r.handoff.replace(/_/g, " ")}</td><td>{r.recording}</td><td>{r.outcome.replace(/_/g, " ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {data && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Concurrency &amp; capacity</CardTitle><CardDescription>Configured target {data.capacity.config.targetConcurrentCalls}, limit {data.capacity.config.maxConfiguredConcurrentCalls}, when full: {data.capacity.config.overflowBehavior.replace(/_/g, " ")}. Session isolation on.</CardDescription></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex justify-between"><span className="text-muted">Session start (incoming → active)</span><span>{ms(data.latency.sessionInitMs)}</span></p>
              <p className="flex justify-between"><span className="text-muted">AI agent per turn</span><span>{ms(data.latency.agentMs)}</span></p>
              <p className="flex justify-between"><span className="text-muted">Webhook round trip (TrulyHello side)</span><span>{ms(data.latency.webhookRoundTripMs)}</span></p>
              <p className="flex justify-between"><span className="text-muted">Speech recognition / speech synthesis / end to end</span><span>not measured</span></p>
              <p className="text-xs text-muted">{data.latency.note}</p>
              <p className="rounded-lg bg-warning-soft p-2 text-xs text-warning">{data.capacity.verifiedNote}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Twilio account &amp; limits</CardTitle><CardDescription>Checks the account type and that your number&apos;s webhook points here.</CardDescription></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {canManage && <Button size="sm" loading={checking} onClick={runCheck}>{check ? "Check again" : "Check Twilio now"}</Button>}
              {check && (
                <>
                  <p><Badge tone={check.status === "verified" ? "success" : check.status === "not_configured" ? "neutral" : "danger"}>{check.status.replace(/_/g, " ")}</Badge> {check.accountType && <span className="text-muted">{check.accountType} account · {check.accountStatus}</span>}</p>
                  <ul className="list-disc space-y-1 pl-5 text-xs text-muted">{check.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </>
              )}
              {!check && <p className="text-xs text-muted">Not checked yet. Twilio&apos;s concurrent-call allowance cannot be read through its API, so it must be confirmed with Twilio and a load test.</p>}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
