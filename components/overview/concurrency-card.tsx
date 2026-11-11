"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useApi } from "@/hooks/use-api";
import { api, errorMessage } from "@/lib/api";

interface Concurrency {
  limits: { effective: number; business: number; carrier: number | null; overflowPolicy: "callback" | "transfer" | "voicemail"; transferConfigured: boolean };
  calls: { active: number; peak: number; utilizationPct: number; byState: Record<string, number> };
  last24h: { sessions: number; completed: number; failed: number; failureCauses: Record<string, number>; overflowed: number; setupMs: { avg: number | null; p95: number | null; samples: number }; avgAgentTurnMs: number | null };
  workers: { poolRegistered: boolean; live: number; down: number; capacity: number; used: number; available: number; avgCpuPct: number | null; recommended: { desired: number; reason: string } | null };
}

/** Live concurrency for the signed-in business only. Figures come from recorded call sessions; nothing is estimated. */
export function ConcurrencyCard({ canEdit }: { canEdit: boolean }) {
  const { data, refetch } = useApi<Concurrency>("/telephony/concurrency", { events: ["call.created", "call.updated"], refreshMs: 5000 });
  const [edit, setEdit] = React.useState<{ max?: string; policy?: string }>({});
  const [msg, setMsg] = React.useState("");

  async function save() {
    setMsg("");
    try { await api("/telephony/concurrency", { method: "PUT", body: { maxConcurrentCalls: Number(max), overflowPolicy: policy } }); setEdit({}); setMsg("Saved."); refetch(); } catch (e) { setMsg(errorMessage(e)); }
  }
  if (!data) return null;
  const max = edit.max ?? String(data.limits.business);
  const policy = edit.policy ?? data.limits.overflowPolicy;
  const { calls, limits, last24h, workers } = data;
  const failures = Object.entries(last24h.failureCauses).map(([k, v]) => `${k.replace(/_/g, " ")} ×${v}`).join(", ");
  const tiles: [string, string | number][] = [
    ["Active calls now", `${calls.active} / ${limits.effective}`],
    ["Peak at once", calls.peak],
    ["Overflowed (24h)", last24h.overflowed],
    ["Failed (24h)", last24h.failed],
    ["Setup time avg / p95", last24h.setupMs.samples ? `${last24h.setupMs.avg} / ${last24h.setupMs.p95} ms` : "n/a"],
    ["Agent time per turn", last24h.avgAgentTurnMs == null ? "n/a" : `${last24h.avgAgentTurnMs} ms`],
    ["Worker capacity free", workers.poolRegistered ? `${workers.available} of ${workers.capacity}` : "no pool registered"],
    ["Workers up / down", workers.poolRegistered ? `${workers.live} / ${workers.down}` : "n/a"],
  ];
  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Simultaneous calls {calls.utilizationPct >= 90 && <Badge tone="danger">near limit</Badge>}</CardTitle>
        <CardDescription>
          Limit {limits.effective} at once (your setting {limits.business}{limits.carrier ? `, carrier line limit ${limits.carrier}` : ", no carrier limit recorded"}). Calls beyond it are never dropped silently: {limits.overflowPolicy === "callback" ? "the caller is told we will call back and a callback is queued" : limits.overflowPolicy === "transfer" ? "the caller is passed to your team's number" : "the caller is sent to voicemail and a callback is queued"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-4">
          {tiles.map(([k, v]) => (
            <div key={k}>
              <dd className="text-xl leading-none font-bold">{v}</dd>
              <dt className="mt-1 text-xs font-semibold text-muted">{k}</dt>
            </div>
          ))}
        </dl>
        {failures && <p className="text-xs text-muted">Failure causes (24h): {failures}</p>}
        {workers.recommended && <p className="text-xs text-muted">Suggested workers: {workers.recommended.desired} ({workers.recommended.reason}). Starting more workers is done in your hosting; this page only recommends.</p>}
        {canEdit && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold text-muted">Max simultaneous calls<Input className="mt-1 w-32" type="number" min={1} max={1000} value={max} onChange={(e) => setEdit((x) => ({ ...x, max: e.target.value }))} /></label>
            <label className="text-xs font-semibold text-muted">When full
              <Select className="mt-1 w-56" value={policy} onValueChange={(v) => setEdit((x) => ({ ...x, policy: v }))} options={[{ value: "callback", label: "Queue a callback" }, { value: "voicemail", label: "Voicemail + callback" }, { value: "transfer", label: "Transfer to my team" }]} />
            </label>
            <Button onClick={save}>Save</Button>
            {msg && <span className="text-xs text-muted">{msg}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
