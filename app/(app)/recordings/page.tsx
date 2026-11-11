"use client";
import * as React from "react";
import { Mic } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/common/states";
import { RecordingDetail } from "@/components/recordings/recording-detail";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { useApi } from "@/hooks/use-api";
import { formatDateTime, formatDuration } from "@/lib/format";

export interface RecordingRow {
  recordingId: string; callUuid?: string; callId: string; status: string; flagged: boolean; durationSeconds?: number; createdAt: string; consentAnnounced: boolean;
  call?: { startedAt: string; status: string; transferStatus: string; outcome: string; callerNumber: string; callerName: string };
}
const FILTERS = [
  { value: "all", label: "All" }, { value: "completed", label: "Completed" }, { value: "missed", label: "Missed" },
  { value: "transferred", label: "Transferred" }, { value: "failed", label: "Failed" }, { value: "flagged", label: "Flagged" },
] as const;

export default function RecordingsPage() {
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]["value"]>("all");
  const [q, setQ] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const params = new URLSearchParams({ filter });
  if (q.trim()) params.set("q", q.trim());
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(`${to}T23:59:59`).toISOString());
  const { data, error, loading, refetch } = useApi<{ recordings: RecordingRow[]; canListen: boolean }>(`/recordings?${params}`);

  return (
    <>
      <PageHeader title="Recordings & transcripts" description="Every recording has its own ID. Playing, downloading, flagging and deleting are logged, and links expire after 5 minutes." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Segmented label="Filter" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ ...f }))} />
        <label className="text-xs font-semibold text-muted">Call ID, Recording ID or phone<Input className="mt-1 w-72" value={q} onChange={(e) => setQ(e.target.value)} placeholder="UUID or +1 415…" /></label>
        <label className="text-xs font-semibold text-muted">From<Input className="mt-1" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs font-semibold text-muted">To<Input className="mt-1" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_28rem]">
        <Card>
          <CardContent className="p-0">
            {loading && !data ? <RowsSkeleton /> : error && !data ? <ErrorState message={error} onRetry={refetch} /> : !data?.recordings.length ? (
              <EmptyState icon={Mic} title="No recordings" description="Recording is off unless you turn it on under Security & privacy. Recordings appear here after a recorded call ends." />
            ) : (
              <ul className="divide-y divide-border">
                {data.recordings.map((r) => (
                  <li key={r.recordingId}>
                    <button onClick={() => setOpen(r.recordingId)} className={`flex w-full flex-wrap items-center justify-between gap-2 px-5 py-3.5 text-left hover:bg-brand-50 ${open === r.recordingId ? "bg-brand-50" : ""}`}>
                      <span>
                        <span className="block text-sm font-semibold">{r.call?.callerName || r.call?.callerNumber || "Unknown caller"}</span>
                        <span className="block text-xs text-muted">{formatDateTime(r.call?.startedAt ?? r.createdAt)} · {formatDuration(r.durationSeconds)} · <code>{r.recordingId.slice(0, 8)}…</code></span>
                      </span>
                      <span className="flex gap-1.5">
                        {r.flagged && <Badge tone="warning">flagged</Badge>}
                        {r.status === "deleted" && <Badge tone="neutral">deleted</Badge>}
                        {r.call && r.call.transferStatus !== "none" && <Badge tone="info">transferred</Badge>}
                        {r.call && <Badge tone={r.call.status === "completed" ? "success" : r.call.status === "failed" ? "danger" : "neutral"}>{r.call.status.replace(/_/g, " ")}</Badge>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        {open ? <RecordingDetail key={open} id={open} onChanged={refetch} onClose={() => setOpen(null)} /> : <Card className="hidden lg:block"><CardContent className="py-10 text-center text-sm text-muted">Select a recording to see its details, transcript and audio.</CardContent></Card>}
      </div>
    </>
  );
}
