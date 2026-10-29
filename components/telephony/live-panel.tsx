import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { type Overview, fmt, kindLabel } from "./shared";

export function LivePanel({ data }: { data: Overview }) {
  const q = data.quality;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Active calls</CardTitle><CardDescription>Calls on the self-managed gateway right now. Calls on Twilio appear in Call activity.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {!data.activeCalls?.length && <p className="text-sm text-muted">No active calls.</p>}
          {data.activeCalls?.map((c) => (
            <div key={c._id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3 text-sm">
              <Badge tone="info">{c.status.replace("_", " ")}</Badge><span className="font-semibold">{c.direction}</span>
              <span className="text-muted">{c.fromNumber} → {c.toNumber}</span><span className="text-xs text-subtle">{kindLabel[c.connectionKind]} · since {new Date(c.startedAt).toLocaleTimeString()}</span>
            </div>
          ))}
          {!!data.openRecoveryTasks && <p className="text-sm font-semibold text-warning">{data.openRecoveryTasks} caller(s) lost to a phone-system problem need a callback (see Follow-ups).</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Call quality and latency</CardTitle><CardDescription>Last 24 hours, only from calls where the gateway or voice worker reported the measurement. “Not measured” means no data, not zero.</CardDescription></CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            {([
              ["Calls on the gateway", String(q?.sessions24h ?? 0)],
              ["Average reply delay", fmt(q?.avgTurnLatencyMs, " ms")],
              ["Slowest reply", fmt(q?.maxTurnLatencyMs, " ms")],
              ["Average jitter", fmt(q?.avgJitterMs, " ms")],
              ["Average packet loss", fmt(q?.avgPacketLossPct, " %")],
              ["Average MOS", fmt(q?.avgMos)],
            ] as const).map(([k, v]) => <div key={k}><dd className="text-xl font-bold">{v}</dd><dt className="text-xs font-semibold text-muted">{k}</dt></div>)}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Failover and recent health events</CardTitle><CardDescription>Outbound calls try your gateway first, then Twilio, then Vapi, skipping any provider that is not connected or whose circuit is open after repeated failures. This is application-level failover only: it does not reroute calls at the carrier.</CardDescription></CardHeader>
        <CardContent className="space-y-1.5">
          {!data.health?.length && <p className="text-sm text-muted">No health events recorded yet.</p>}
          {data.health?.map((h) => <p key={h._id} className="text-sm"><span className="text-xs text-subtle">{new Date(h.at).toLocaleString()}</span> · <span className="font-semibold">{h.provider}</span> · {h.kind.replace("_", " ")}{h.detail ? `: ${h.detail}` : ""}</p>)}
        </CardContent>
      </Card>
    </div>
  );
}
