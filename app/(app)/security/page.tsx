"use client";
import * as React from "react";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/states";
import { MfaPanel } from "@/components/security/mfa-panel";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface Overview {
  authentication: { method: string; lockout: string; cookieSecure: boolean };
  mfa: { available: boolean; required: boolean; privilegedUsers: number; enrolled: number };
  users: { id: string; name: string; email: string; role: string; active: boolean; mfa: boolean }[];
  recentLogins: { at: string; email: string; outcome: string; ip?: string }[];
  failedLogins24h: number;
  sensitiveAccess: { at: string; action: string; actor?: string }[];
  recordingAccess: { at: string; action: string; actor?: string; recording?: string }[];
  alerts: { level: "high" | "medium" | "info"; message: string }[];
  alertsNote: string;
  backups: { status: string; note: string };
  retention: { transcriptDays: number; recordingDays: number; recordingsStored: number; recordingEnabled: boolean };
  permissions: { staffCanListen: boolean; staffCanSeePhone: boolean };
  integrations: { name: string; status: string; detail: string }[];
  encryption: { inTransit: string; atRest: string };
}
const tone = (s: string): BadgeTone => (s === "success" ? "success" : s === "connected" || s === "configured" ? "success" : s === "not_configured" || s === "unknown" ? "neutral" : s === "degraded" || s === "testing" ? "warning" : "danger");

export default function SecurityPage() {
  const { session } = useSession();
  const isOwner = session.user.role === "owner";
  const { data, error, loading, refetch } = useApi<Overview>(session.user.role === "staff" ? null : "/security", { refreshMs: 30_000 });
  const [msg, setMsg] = React.useState("");
  async function save(patch: Record<string, unknown>) { setMsg(""); try { await api("/security/settings", { method: "PUT", body: patch }); refetch(); } catch (e) { setMsg(errorMessage(e)); } }

  return (
    <>
      <PageHeader title="Security & privacy" description="Who can sign in, who has accessed sensitive data, and what is stored. Nothing on this page claims protection the application cannot verify." />
      {session.user.role === "staff" ? (
        <Card><CardContent className="flex items-center gap-2 py-8 text-sm text-muted"><Lock className="size-4" /> Only owners and admins can see this page.</CardContent></Card>
      ) : (
        <div className="space-y-5">
          {["owner", "admin"].includes(session.user.role) && <MfaPanel />}
          {loading && !data ? <Skeleton className="h-64" /> : error && !data ? <Card><ErrorState message={error} onRetry={refetch} /></Card> : data && (
            <>
              <Card>
                <CardHeader><CardTitle>Alerts</CardTitle><CardDescription>{data.alertsNote}</CardDescription></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {data.alerts.length === 0 ? <p className="text-muted">No alerts.</p> : data.alerts.map((a, i) => <p key={i} className="flex items-center gap-2"><Badge tone={a.level === "high" ? "danger" : a.level === "medium" ? "warning" : "info"}>{a.level}</Badge>{a.message}</p>)}
                </CardContent>
              </Card>
              <div className="grid gap-5 lg:grid-cols-2">
                <Card>
                  <CardHeader><CardTitle>Authentication &amp; roles</CardTitle><CardDescription>{data.authentication.method}. Lockout: {data.authentication.lockout}. Two-step enrolled: {data.mfa.enrolled} of {data.mfa.privilegedUsers} owners/admins.</CardDescription></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {data.users.map((u) => <p key={u.id} className="flex items-center justify-between"><span>{u.name} <span className="text-muted">{u.email}</span></span><span className="flex gap-1.5"><Badge>{u.role}</Badge><Badge tone={u.mfa ? "success" : "neutral"}>{u.mfa ? "2-step" : "no 2-step"}</Badge>{!u.active && <Badge tone="danger">disabled</Badge>}</span></p>)}
                    {isOwner && (
                      <div className="mt-3 space-y-2 border-t border-border pt-3">
                        <label className="flex items-center justify-between gap-3">Require two-step sign-in for owners &amp; admins <Switch checked={data.mfa.required} onCheckedChange={(v) => save({ requireMfa: v })} /></label>
                        <label className="flex items-center justify-between gap-3">Staff may listen to recordings <Switch checked={data.permissions.staffCanListen} onCheckedChange={(v) => save({ staffCanListen: v })} /></label>
                        <label className="flex items-center justify-between gap-3">Staff may see full phone numbers <Switch checked={data.permissions.staffCanSeePhone} onCheckedChange={(v) => save({ staffCanSeePhone: v })} /></label>
                        {msg && <p className="text-xs text-danger">{msg}</p>}
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Recent sign-ins</CardTitle><CardDescription>{data.failedLogins24h} failed attempt(s) in the last 24 hours.</CardDescription></CardHeader>
                  <CardContent className="space-y-1.5 text-xs">
                    {data.recentLogins.length === 0 ? <p className="text-muted">No sign-ins recorded yet.</p> : data.recentLogins.slice(0, 10).map((l, i) => <p key={i} className="flex justify-between gap-2"><span>{formatDateTime(l.at)} · {l.email}</span><Badge tone={l.outcome === "success" ? "success" : l.outcome === "mfa_required" ? "neutral" : "danger"}>{l.outcome.replace(/_/g, " ")}</Badge></p>)}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Recording access log</CardTitle><CardDescription>Every link issued, play, download, flag and deletion.</CardDescription></CardHeader>
                  <CardContent className="space-y-1.5 text-xs">
                    {data.recordingAccess.length === 0 ? <p className="text-muted">No recording access yet.</p> : data.recordingAccess.slice(0, 10).map((l, i) => <p key={i} className="flex justify-between gap-2"><span>{formatDateTime(l.at)} · {l.action.replace("recording.", "").replace(/_/g, " ")}</span><code>{l.recording?.slice(0, 8)}…</code></p>)}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Sensitive data activity</CardTitle><CardDescription>Transcript views, deletions, two-step changes, privacy settings.</CardDescription></CardHeader>
                  <CardContent className="space-y-1.5 text-xs">
                    {data.sensitiveAccess.length === 0 ? <p className="text-muted">Nothing yet.</p> : data.sensitiveAccess.slice(0, 10).map((l, i) => <p key={i}>{formatDateTime(l.at)} · {l.action.replace(/[._]/g, " ")}</p>)}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Retention &amp; backups</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p>Recording: <Badge tone={data.retention.recordingEnabled ? "warning" : "neutral"}>{data.retention.recordingEnabled ? "on" : "off"}</Badge> · {data.retention.recordingsStored} stored · deleted after {data.retention.recordingDays} days. Transcripts: {data.retention.transcriptDays} days.</p>
                    {isOwner && <label className="flex items-center gap-2 text-xs text-muted">Recording retention (days)<Input className="w-24" type="number" min={1} max={3650} defaultValue={data.retention.recordingDays} onBlur={(e) => e.target.value && save({ recordingRetentionDays: Number(e.target.value) })} /></label>}
                    <p className="text-xs text-muted"><Badge tone={tone(data.backups.status)}>backups: {data.backups.status}</Badge> {data.backups.note}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Integrations &amp; encryption</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {data.integrations.map((i) => <p key={i.name} className="flex items-center justify-between gap-2"><span>{i.name}</span><Badge tone={tone(i.status)}>{i.status.replace(/_/g, " ")}</Badge></p>)}
                    <p className="border-t border-border pt-2 text-muted">In transit: {data.encryption.inTransit}</p>
                    <p className="text-muted">At rest: {data.encryption.atRest}</p>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
