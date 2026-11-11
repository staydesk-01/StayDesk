"use client";
import * as React from "react";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/states";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type St = "pass" | "fail" | "needs_review" | "not_tested";
interface Scenario { id: string; name: string; concurrency: number; automated: { status: St; detail: string }; live: { status: St; notes?: string; concurrency?: number; testedBy?: string; testedAt?: string } }
interface Data { scenarios: Scenario[]; automatedRun: { generatedAt?: string; warning?: string } | null; verifiedConcurrentCalls: number; verifiedNote: string }
const tone: Record<St, BadgeTone> = { pass: "success", fail: "danger", needs_review: "warning", not_tested: "neutral" };
const label = (s: St) => s.replace("_", " ");

export default function ConcurrentTestingPage() {
  const { canManage } = useSession();
  const { data, error, loading, refetch } = useApi<Data>(canManage ? "/qa/concurrency" : null);
  const [edit, setEdit] = React.useState<Record<string, { status: St; notes: string; concurrency: string }>>({});
  const [msg, setMsg] = React.useState("");
  async function save(s: Scenario) {
    const e = edit[s.id];
    if (!e) return;
    setMsg("");
    try { await api(`/qa/concurrency/${s.id}`, { method: "PUT", body: { status: e.status, notes: e.notes, concurrency: e.concurrency ? Number(e.concurrency) : undefined } }); setEdit((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== s.id))); refetch(); } catch (err) { setMsg(errorMessage(err)); }
  }
  return (
    <>
      <PageHeader title="Concurrent call testing" description="Automated checks run the real webhook code with simulated Twilio requests. Only a live test with real phones, recorded by a person, counts as verified capacity." />
      {!canManage ? <Card><CardContent className="flex items-center gap-2 py-8 text-sm text-muted"><Lock className="size-4" /> Only owners and admins can see this page.</CardContent></Card> : loading && !data ? <Skeleton className="h-64" /> : error && !data ? <Card><ErrorState message={error} onRetry={refetch} /></Card> : data && (
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Verified concurrency: {data.verifiedConcurrentCalls ? `${data.verifiedConcurrentCalls} callers` : "none yet"}</CardTitle><CardDescription>{data.verifiedNote}</CardDescription></CardHeader>
            {data.automatedRun && <CardContent className="text-xs text-muted">Last automated run {formatDateTime(data.automatedRun.generatedAt)}. {data.automatedRun.warning}</CardContent>}
          </Card>
          {msg && <p className="text-sm text-danger">{msg}</p>}
          <Card>
            <CardContent className="divide-y divide-border p-0">
              {data.scenarios.map((s) => {
                const e = edit[s.id];
                return (
                  <div key={s.id} className="space-y-2 px-5 py-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{s.name}</span>
                      <span className="flex gap-2"><Badge tone={tone[s.automated.status]}>automated (simulated): {label(s.automated.status)}</Badge><Badge tone={tone[s.live.status]}>live: {label(s.live.status)}</Badge></span>
                    </div>
                    <p className="text-xs text-muted">{s.automated.detail}</p>
                    {s.live.testedAt && <p className="text-xs text-muted">Live result by {s.live.testedBy} on {formatDateTime(s.live.testedAt)}{s.live.concurrency ? `, ${s.live.concurrency} callers` : ""}. {s.live.notes}</p>}
                    {e ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <Select className="w-44" value={e.status} onValueChange={(v) => setEdit((x) => ({ ...x, [s.id]: { ...e, status: v as St } }))} options={[{ value: "pass", label: "Pass" }, { value: "fail", label: "Fail" }, { value: "needs_review", label: "Needs review" }, { value: "not_tested", label: "Not tested" }]} />
                        <Input className="w-32" type="number" placeholder="Callers at once" value={e.concurrency} onChange={(ev) => setEdit((x) => ({ ...x, [s.id]: { ...e, concurrency: ev.target.value } }))} />
                        <Input className="w-72" placeholder="What happened (misunderstandings, latency, issues)" value={e.notes} onChange={(ev) => setEdit((x) => ({ ...x, [s.id]: { ...e, notes: ev.target.value } }))} />
                        <Button size="sm" onClick={() => save(s)}>Save</Button>
                      </div>
                    ) : <Button size="sm" variant="outline" onClick={() => setEdit((x) => ({ ...x, [s.id]: { status: s.live.status === "not_tested" ? "pass" : s.live.status, notes: s.live.notes ?? "", concurrency: String(s.live.concurrency ?? s.concurrency) } }))}>Record live result</Button>}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
