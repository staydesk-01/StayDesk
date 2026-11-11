"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";

/** Two-step sign-in for the signed-in owner/admin. Uses only /api/auth/* so it still works when the business requires MFA before anything else. */
export function MfaPanel() {
  const { session, refresh } = useSession();
  const [setup, setSetup] = React.useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [recovery, setRecovery] = React.useState<string[] | null>(null);
  const [msg, setMsg] = React.useState("");
  const on = !!session.mfa?.enabled;

  async function run(fn: () => Promise<void>) { setMsg(""); try { await fn(); } catch (e) { setMsg(errorMessage(e)); } }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Two-step sign-in <Badge tone={on ? "success" : session.mfa?.setupRequired ? "danger" : "neutral"}>{on ? "on" : session.mfa?.setupRequired ? "required — not set up" : "off"}</Badge></CardTitle>
        <CardDescription>Uses an authenticator app (Google Authenticator, 1Password, Authy…). Available to owners and admins.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {recovery && (
          <div className="rounded-xl border border-border bg-brand-50 p-4">
            <p className="font-semibold">Save these recovery codes now. They are shown once and each works one time.</p>
            <p className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">{recovery.map((c) => <span key={c}>{c}</span>)}</p>
            <Button className="mt-3" size="sm" onClick={() => setRecovery(null)}>I have saved them</Button>
          </div>
        )}
        {!on && !setup && !recovery && <Button onClick={() => run(async () => setSetup(await api("/auth/mfa/setup", { method: "POST", body: {} })))}>Set up two-step sign-in</Button>}
        {setup && (
          <div className="space-y-2">
            <p>Add this key to your authenticator app (choose “enter a setup key”, time-based), then type the 6-digit code it shows.</p>
            <p className="rounded-lg bg-brand-50 p-2 font-mono text-xs break-all select-all">{setup.secret}</p>
            <div className="flex gap-2">
              <Input className="w-40" inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} aria-label="6-digit code" />
              <Button onClick={() => run(async () => { const r = await api<{ recoveryCodes: string[] }>("/auth/mfa/enable", { method: "POST", body: { code } }); setRecovery(r.recoveryCodes); setSetup(null); setCode(""); await refresh(); })}>Turn on</Button>
            </div>
          </div>
        )}
        {on && !recovery && (
          <div className="flex flex-wrap items-end gap-2">
            <Input className="w-48" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
            <Input className="w-40" placeholder="Code or recovery code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code" />
            <Button variant="outline" onClick={() => run(async () => { await api("/auth/mfa/disable", { method: "POST", body: { password, code } }); setPassword(""); setCode(""); await refresh(); })}>Turn off</Button>
          </div>
        )}
        {msg && <p className="text-xs text-danger">{msg}</p>}
      </CardContent>
    </Card>
  );
}
