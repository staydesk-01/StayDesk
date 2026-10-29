"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { ToggleRow } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { api, errorMessage } from "@/lib/api";
import type { Overview } from "./shared";

const PURPOSES = [
  ["reservation_reminder", "Reservation reminders"],
  ["customer_callback", "Customer-requested callbacks"],
  ["order_status", "Order status updates"],
  ["approved_follow_up", "Staff-approved follow-ups"],
] as const;

export function OutboundPanel({ data, refetch }: { data: Overview; refetch: () => void }) {
  const { toast } = useToast();
  const lists = useApi<{ consents: { _id: string; phone: string; purpose: string; evidence: string }[]; suppressed: { _id: string; phone: string; reason: string }[] }>(data.flags.outboundCalling ? "/outbound" : "/telephony");
  const s = data.outboundSettings;
  const [local, setLocal] = React.useState({ windowStart: s?.windowStart ?? "09:00", windowEnd: s?.windowEnd ?? "20:00", jurisdictionNote: s?.jurisdictionNote ?? "" });
  const [consent, setConsent] = React.useState({ phone: "", purpose: "reservation_reminder", evidence: "" });
  const [dnc, setDnc] = React.useState("");
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); refetch(); lists.refetch(); } catch (e) { toast(errorMessage(e), "error"); } };
  const save = (patch: object) => run(() => api("/outbound/settings", { method: "PUT", body: patch }), "Saved");

  if (!data.flags.outboundCalling) return <Card><CardContent className="py-8 text-sm text-muted">Outbound calling is switched off for this deployment (FEATURE_OUTBOUND_CALLING). Nothing here can place a call.</CardContent></Card>;
  const purposes = new Set(s?.purposes ?? []);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Outbound calling</CardTitle><CardDescription>Off until you turn it on and approve each purpose. Calls are only made to people with a recorded consent or their own request, never to numbers on the do-not-call list, and only in the hours below at the recipient’s local time. StayDesk’s rules are conservative defaults, not legal advice: you are responsible for the laws that apply to you.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow title="Allow outbound calls" description="Master switch for this business." checked={!!s?.enabled} onCheckedChange={(v) => save({ enabled: v })} />
          {PURPOSES.map(([k, label]) => (
            <ToggleRow key={k} title={label} checked={purposes.has(k)} onCheckedChange={(v) => save({ purposes: v ? [...purposes, k] : [...purposes].filter((p) => p !== k) })} />
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Earliest call (recipient local time)" hint="Never earlier than 08:00."><Input type="time" value={local.windowStart} onChange={(e) => setLocal({ ...local, windowStart: e.target.value })} /></Field>
            <Field label="Latest call (recipient local time)" hint="Never later than 21:00."><Input type="time" value={local.windowEnd} onChange={(e) => setLocal({ ...local, windowEnd: e.target.value })} /></Field>
          </div>
          <Field label="Jurisdiction note" hint="Recorded for audits, e.g. which rules you reviewed."><Input value={local.jurisdictionNote} onChange={(e) => setLocal({ ...local, jurisdictionNote: e.target.value })} /></Field>
          <Button onClick={() => save(local)}>Save hours and note</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Consent and do-not-call</CardTitle><CardDescription>Consent needs evidence of how it was given. A number on the do-not-call list is never called.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Phone"><Input placeholder="+13105550111" value={consent.phone} onChange={(e) => setConsent({ ...consent, phone: e.target.value })} /></Field>
            <Field label="Purpose"><select className="h-10 rounded-xl border border-border-strong bg-surface px-3 text-sm" value={consent.purpose} onChange={(e) => setConsent({ ...consent, purpose: e.target.value })} aria-label="Consent purpose">{PURPOSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="How consent was given"><Input value={consent.evidence} onChange={(e) => setConsent({ ...consent, evidence: e.target.value })} /></Field>
          </div>
          <Button variant="outline" onClick={() => run(() => api("/outbound/consent", { method: "POST", body: consent }).then(() => setConsent({ ...consent, phone: "", evidence: "" })), "Consent recorded")}>Record consent</Button>
          <p className="text-xs text-muted">{lists.data?.consents?.length ?? 0} active consent record(s).</p>
          <div className="flex gap-2"><Input placeholder="+13105550111" aria-label="Number to suppress" value={dnc} onChange={(e) => setDnc(e.target.value)} /><Button variant="danger-outline" onClick={() => run(() => api("/outbound/suppression", { method: "POST", body: { phone: dnc } }).then(() => setDnc("")), "Added to the do-not-call list")}>Do not call</Button></div>
          <p className="text-xs text-muted">{lists.data?.suppressed?.length ?? 0} number(s) on the do-not-call list.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent outbound requests</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {!data.outbound?.length && <p className="text-sm text-muted">No outbound requests yet.</p>}
          {data.outbound?.map((r) => (
            <div key={r._id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3 text-sm">
              <Badge tone={r.status === "completed" ? "success" : r.status === "blocked" || r.status === "failed" || r.status === "exhausted" ? "danger" : "info"}>{r.status}</Badge>
              <span className="font-semibold">{r.purpose.replace(/_/g, " ")}</span><span className="text-muted">{r.toNumber}</span>
              <span className="text-xs text-muted">attempt {r.attempts}/{r.maxAttempts}{r.blockedReason ? ` · ${r.blockedReason}` : r.lastError ? ` · ${r.lastError}` : ""}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
