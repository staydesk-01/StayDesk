"use client";
import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { type Overview, StatusPill, kindLabel } from "./shared";

const FIELDS: Record<string, { settings: { key: string; label: string; hint?: string }[]; secrets: { key: string; label: string }[] }> = {
  sip_gateway: { settings: [{ key: "controlUrl", label: "Gateway control URL", hint: "HTTPS address of your SIP gateway's control API." }], secrets: [{ key: "controlSecret", label: "Shared signing secret (32+ characters)" }] },
  twilio: { settings: [], secrets: [{ key: "accountSid", label: "Account SID (optional: server default is used if blank)" }, { key: "authToken", label: "Auth token" }] },
  vapi: { settings: [{ key: "assistantId", label: "Assistant id" }, { key: "phoneNumberId", label: "Phone number id" }], secrets: [{ key: "apiKey", label: "API key" }] },
};

export function ConnectionsPanel({ data, refetch }: { data: Overview; refetch: () => void }) {
  const { toast } = useToast();
  const [kind, setKind] = React.useState("sip_gateway");
  const [vals, setVals] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState("");
  const spec = FIELDS[kind];
  const set = (k: string, v: string) => setVals((x) => ({ ...x, [k]: v }));

  async function save() {
    setBusy("save");
    try {
      const settings = Object.fromEntries((spec?.settings ?? []).map((f) => [f.key, vals[f.key]]).filter(([, v]) => v));
      const secrets = Object.fromEntries((spec?.secrets ?? []).map((f) => [f.key, vals[f.key]]).filter(([, v]) => v));
      await api("/telephony/connections", { method: "POST", body: { kind, settings, secrets } });
      setVals({});
      toast("Saved. Run a test to check it.");
      refetch();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(""); }
  }
  async function test(k: string) {
    setBusy(k);
    try {
      const r = await api<{ status: string; reason: string }>(`/telephony/connections/${k}/test`, { method: "POST" });
      toast(`${r.status.replace("_", " ")}: ${r.reason}`, r.status === "connected" ? "success" : "error");
      refetch();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(""); }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Provider health</CardTitle><CardDescription>“Connected” means the provider’s control API answered the last check. It does not prove a phone call works end to end: place a test call.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {!data.connections?.length && <p className="text-sm text-muted">No connections yet. Add one below.</p>}
          {data.connections?.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-semibold">{kindLabel[c.kind] ?? c.kind} <StatusPill status={c.status} /></p>
                <p className="text-xs text-muted">{c.reason || "No details yet."}</p>
                <p className="text-xs text-subtle">{c.lastCheckedAt ? `Last checked ${new Date(c.lastCheckedAt).toLocaleString()}` : "Never checked"}{Object.keys(c.secrets).length ? ` · stored credentials: ${Object.entries(c.secrets).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}</p>
              </div>
              <Button size="sm" variant="outline" loading={busy === c.kind} onClick={() => test(c.kind)}>Test</Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Add or update a connection</CardTitle><CardDescription>Credentials are encrypted before they are stored and are never shown again. {!data.flags.secretsConfigured && "The server has no TELEPHONY_SECRET_KEY yet, so credentials cannot be saved."}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Field label="Connection type"><Select value={kind} onValueChange={(v) => { setKind(v); setVals({}); }} aria-label="Connection type" options={(data.available ?? []).map((a) => ({ value: a.kind, label: kindLabel[a.kind] ?? a.kind }))} /></Field>
          {!spec ? <p className="text-sm text-muted">This adapter is not implemented, so there is nothing to configure.</p> : (
            <>
              {spec.settings.map((f) => <Field key={f.key} label={f.label} hint={f.hint}><Input value={vals[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} /></Field>)}
              {spec.secrets.map((f) => <Field key={f.key} label={f.label}><Input type="password" autoComplete="off" value={vals[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} /></Field>)}
              <Button loading={busy === "save"} onClick={save}>Save connection</Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
