"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, PhoneCall, Search } from "lucide-react";
import { HandledByBadge, IntentBadge, OutcomeBadge, TestBadge, SampleBadge, TransferBadge } from "@/components/common/badges";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { useApi } from "@/hooks/use-api";
import { callerLabel, formatDate, formatDuration, formatPhone, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Call } from "@/types";

type Range = "today" | "7d" | "30d" | "all";
type Filter = "all" | "ai" | "transferred" | "follow_up" | "completed" | "failed";

const RANGES: { value: Range; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All calls" },
  { value: "ai", label: "AI handled" },
  { value: "transferred", label: "Transferred" },
  { value: "follow_up", label: "Needs follow-up" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const Source = ({ c }: { c: Call }) => (c.provider === "simulator" ? (c.isDemo ? <SampleBadge /> : <TestBadge />) : null);

export default function CallsPage() {
  const router = useRouter();
  const [range, setRange] = React.useState<Range>("30d");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ range, filter, page: String(page), limit: "20" });
  if (debouncedQ) params.set("q", debouncedQ);
  const { data, error, loading, refetch } = useApi<{ calls: Call[]; total: number; pages: number }>(`/calls?${params}`, { events: ["call.created", "call.updated"], refreshMs: 30_000 });

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <>
      <PageHeader title="Call activity" description="Every call StayDesk handled: who called, what they needed, and what happened next." />

      <Card>
        <div className="flex flex-col gap-4 border-b border-border p-5 sm:p-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Segmented label="Date range" value={range} onChange={reset(setRange)} options={RANGES} />
            <div className="relative w-full lg:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle" />
              <Input value={q} onChange={(e) => reset(setQ)(e.target.value)} placeholder="Search name or number" className="pl-10" aria-label="Search calls" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter calls">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => reset(setFilter)(f.value)}
                aria-pressed={filter === f.value}
                className={cn("rounded-full border px-3.5 py-1.5 text-sm font-semibold transition", filter === f.value ? "border-brand-600 bg-brand-600 text-white" : "border-border-strong bg-surface text-muted hover:border-brand-300 hover:text-foreground")}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {loading && !data ? (
          <RowsSkeleton rows={8} />
        ) : error && !data ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : !data?.calls.length ? (
          <EmptyState
            icon={PhoneCall}
            title="No calls match these filters"
            description={filter === "all" && range === "all" && !debouncedQ ? "When customers call, their conversations will appear here. Try the test console to simulate one." : "Try a wider date range or clear the filters."}
            action={
              filter === "all" && range === "all" ? (
                <Button asChild><Link href="/test-agent">Test your agent</Link></Button>
              ) : (
                <Button variant="outline" onClick={() => { setFilter("all"); setRange("all"); setQ(""); }}>Clear filters</Button>
              )
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs font-semibold tracking-wide text-muted uppercase">
                    {["Caller", "Date", "Time", "Duration", "Handled by", "Intent", "Outcome", "Follow-up", "Transfer"].map((h, i) => (
                      <th key={h} className={cn("px-3 py-3", i === 0 && "pl-6", i === 8 && "pr-6")}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.calls.map((c) => (
                    <tr key={c._id} onClick={() => router.push(`/calls/${c._id}`)} className="cursor-pointer border-b border-border/60 transition last:border-0 hover:bg-brand-50/60">
                      <td className="py-3.5 pr-3 pl-6">
                        <Link href={`/calls/${c._id}`} onClick={(e) => e.stopPropagation()} className="flex flex-col outline-none focus-visible:underline">
                          <span className="flex items-center gap-2 font-semibold">{callerLabel(c)} <Source c={c} /></span>
                          {c.callerName && <span className="text-xs text-muted">{formatPhone(c.callerNumber)}</span>}
                        </Link>
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-muted">{formatDate(c.startedAt)}</td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-muted">{formatTime(c.startedAt)}</td>
                      <td className="px-3 py-3.5 whitespace-nowrap tabular-nums">{formatDuration(c.durationSeconds)}</td>
                      <td className="px-3 py-3.5"><HandledByBadge by={c.handledBy} /></td>
                      <td className="px-3 py-3.5"><IntentBadge intent={c.intent} /></td>
                      <td className="px-3 py-3.5"><OutcomeBadge outcome={c.outcome} /></td>
                      <td className="px-3 py-3.5">{c.followUpRequired ? <Badge tone="warning">Needs follow-up</Badge> : <span className="text-subtle">—</span>}</td>
                      <td className="py-3.5 pr-6 pl-3"><TransferBadge status={c.transferStatus} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <ul className="divide-y divide-border lg:hidden">
              {data.calls.map((c) => (
                <li key={c._id}>
                  <Link href={`/calls/${c._id}`} className="block space-y-2.5 px-5 py-4 active:bg-brand-50">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex items-center gap-2 font-semibold">{callerLabel(c)} <Source c={c} /></span>
                      <span className="text-xs whitespace-nowrap text-muted">{formatDate(c.startedAt)}, {formatTime(c.startedAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <IntentBadge intent={c.intent} />
                      <OutcomeBadge outcome={c.outcome} />
                      {c.followUpRequired && <Badge tone="warning">Follow-up</Badge>}
                    </div>
                    <p className="text-xs text-muted">{formatDuration(c.durationSeconds)} · <HandledByBadge by={c.handledBy} /></p>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="flex items-center justify-between border-t border-border px-5 py-4 text-sm text-muted sm:px-6">
              <span>{data.total} call{data.total === 1 ? "" : "s"}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft /></Button>
                <span className="min-w-16 text-center">Page {page} of {data.pages}</span>
                <Button variant="outline" size="icon" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight /></Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
