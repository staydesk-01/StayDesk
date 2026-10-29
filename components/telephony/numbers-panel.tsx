"use client";
import * as React from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { type Overview, StatusPill } from "./shared";

const MODES = [
  { value: "forwarding", label: "Existing number, forwarded to StayDesk" },
  { value: "sip_direct", label: "Direct SIP / PBX routing" },
  { value: "ported", label: "Ported to StayDesk's carrier" },
  { value: "provider_number", label: "Number bought from a provider" },
];

export function NumbersPanel({ data, refetch }: { data: Overview; refetch: () => void }) {
  const { toast } = useToast();
  const [number, setNumber] = React.useState("");
  const [mode, setMode] = React.useState("forwarding");
  const [answerMode, setAnswerMode] = React.useState("overflow");
  const [role, setRole] = React.useState("inbound");
  const [codes, setCodes] = React.useState<Record<string, string>>({});
  const [trunk, setTrunk] = React.useState({ name: "", host: "", allowedIps: "", maxConcurrentCalls: "10" });
  const [busy, setBusy] = React.useState("");

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok); refetch(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(""); }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Existing number connection</CardTitle><CardDescription>A number only receives calls here after you prove you control it with a code. “All calls” makes StayDesk answer first; “overflow” keeps your staff first.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {data.numbers?.map((n) => (
            <div key={n._id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3 text-sm">
              <span className="font-semibold">{n.e164}</span>
              <Badge tone={n.verification?.status === "verified" ? "success" : "warning"}>{n.verification?.status === "verified" ? "Verified" : "Not verified"}</Badge>
              <span className="text-xs text-muted">{MODES.find((m) => m.value === n.mode)?.label} · {n.answerMode === "all_calls" ? "answers all calls" : "overflow only"}{n.callerIdAuthorized ? " · caller ID authorised" : ""}</span>
              <span className="ml-auto flex items-center gap-2">
                {n.verification?.status !== "verified" && (
                  <>
                    <Input className="h-8 w-28" inputMode="numeric" maxLength={6} placeholder="6-digit code" aria-label="Verification code" value={codes[n._id] ?? ""} onChange={(e) => setCodes((c) => ({ ...c, [n._id]: e.target.value }))} />
                    <Button size="sm" loading={busy === n._id} onClick={() => run(n._id, () => api(`/telephony/numbers/${n._id}/verify`, { method: "POST", body: { code: codes[n._id] } }), "Number verified")}>Verify</Button>
                  </>
                )}
                <Button size="icon" variant="ghost" aria-label="Remove number" onClick={() => run(`rm${n._id}`, () => api(`/telephony/numbers/${n._id}`, { method: "DELETE" }), "Removed")}><Trash2 /></Button>
              </span>
            </div>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone number"><Input placeholder="+14155550123" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
            <Field label="How callers reach StayDesk"><Select value={mode} onValueChange={setMode} options={MODES} aria-label="Connection mode" /></Field>
            <Field label="Who answers"><Select value={answerMode} onValueChange={setAnswerMode} aria-label="Answer mode" options={[{ value: "overflow", label: "Staff first, StayDesk on no answer" }, { value: "all_calls", label: "StayDesk answers all calls" }]} /></Field>
            <Field label="Use for"><Select value={role} onValueChange={setRole} aria-label="Number role" options={[{ value: "inbound", label: "Inbound calls" }, { value: "both", label: "Inbound + outbound caller ID" }, { value: "outbound_caller_id", label: "Outbound caller ID only" }]} /></Field>
          </div>
          <Button loading={busy === "add"} onClick={() => run("add", () => api("/telephony/numbers", { method: "POST", body: { number, mode, answerMode, role } }).then(() => setNumber("")), "Number added. Enter the verification code to finish.")}>Add number</Button>
          <p className="text-xs text-muted">The code is sent to the number itself by text message when an SMS provider is configured. If it cannot be sent, the number stays unverified: it is never shown on this page.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>SIP trunks</CardTitle><CardDescription>Closed by default: only the IP addresses listed here may send calls. Unencrypted signalling and media together are refused.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {!data.trunks?.length && <p className="text-sm text-muted">No trunks configured.</p>}
          {data.trunks?.map((t) => (
            <div key={t._id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3 text-sm">
              <span className="font-semibold">{t.name}</span><StatusPill status={t.status} />
              <span className="text-xs text-muted">{t.host} · {t.transport.toUpperCase()}{t.srtp ? " + SRTP" : ""} · up to {t.maxConcurrentCalls} calls · {t.allowedIps.length ? `allowed: ${t.allowedIps.join(", ")}` : "no IPs allowed yet (rejects everything)"}</span>
            </div>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={trunk.name} onChange={(e) => setTrunk({ ...trunk, name: e.target.value })} /></Field>
            <Field label="Carrier host"><Input placeholder="sip.carrier.example:5061" value={trunk.host} onChange={(e) => setTrunk({ ...trunk, host: e.target.value })} /></Field>
            <Field label="Allowed carrier IPs (comma separated)"><Input value={trunk.allowedIps} onChange={(e) => setTrunk({ ...trunk, allowedIps: e.target.value })} /></Field>
            <Field label="Max simultaneous calls"><Input type="number" min={1} value={trunk.maxConcurrentCalls} onChange={(e) => setTrunk({ ...trunk, maxConcurrentCalls: e.target.value })} /></Field>
          </div>
          <Button loading={busy === "trunk"} onClick={() => run("trunk", () => api("/telephony/trunks", { method: "POST", body: { name: trunk.name, host: trunk.host, allowedIps: trunk.allowedIps.split(",").map((s) => s.trim()).filter(Boolean), maxConcurrentCalls: Number(trunk.maxConcurrentCalls) } }), "Trunk saved")}>Save trunk</Button>
        </CardContent>
      </Card>
    </div>
  );
}
