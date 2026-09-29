"use client";
import * as React from "react";
import { Info, Lock, PhoneCall, Save, Settings2, Sparkles } from "lucide-react";
import { CopyField } from "@/components/common/copy-field";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/states";
import { ForwardingDiagram } from "@/components/routing/forwarding-diagram";
import { StatusTiles } from "@/components/routing/status-tiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleRow } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PhoneConfig, PhoneStatus, RoutingResponse } from "@/types";

const KEYS = ["mode", "twilioNumber", "existingNumber", "voiceProvider", "humanFirst", "ringSeconds", "noAnswerToAi", "busyToAi", "afterHoursToAi", "overflowToAi", "maxConcurrentHumanCalls", "aiOnly", "humanNumber", "forwardingConfigured", "agentActive"] as const;
type Draft = Pick<PhoneConfig, (typeof KEYS)[number]>;

const modes = [
  { value: "new_twilio" as const, tag: "Mode A", title: "New Twilio number", text: "Callers dial a new StayDesk number directly. StayDesk rings your team first, then the AI. Best for testing." },
  { value: "existing_number" as const, tag: "Mode B", title: "Existing business number", text: "Keep your public number. Your carrier forwards busy / unanswered calls to a StayDesk number. Best for pilots." },
];

const toDraft = (config: PhoneConfig) => Object.fromEntries(KEYS.map((k) => [k, config[k] ?? (k === "twilioNumber" ? "" : undefined)])) as unknown as Draft;

export default function CallRoutingPage() {
  const { data, error, refetch } = useApi<RoutingResponse>("/routing");
  if (error && !data) return <Card><ErrorState message={error} onRetry={refetch} /></Card>;
  if (!data) return <div className="space-y-5"><Skeleton className="h-24" /><Skeleton className="h-64" /><Skeleton className="h-96" /></div>;
  return <RoutingForm data={data} />;
}

function RoutingForm({ data }: { data: RoutingResponse }) {
  const { toast } = useToast();
  const { canManage } = useSession();
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(data.config));
  const [saved, setSaved] = React.useState(() => JSON.stringify(toDraft(data.config)));
  const [status, setStatus] = React.useState<PhoneStatus>(data.status);
  const [saving, setSaving] = React.useState(false);

  const dirty = JSON.stringify(draft) !== saved;
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const aiOnly = draft.aiOnly;
  const humanRules = !aiOnly && draft.mode === "new_twilio";

  async function save() {
    setSaving(true);
    try {
      const res = await api<{ config: PhoneConfig; status: PhoneStatus }>("/routing", { method: "PATCH", body: { ...draft, twilioNumber: draft.twilioNumber ?? "" } });
      const d = toDraft(res.config);
      setDraft(d);
      setSaved(JSON.stringify(d));
      setStatus(res.status);
      toast("Routing settings saved");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Call routing" description="Choose how calls reach StayDesk and when your team or the AI should pick up." />

      <StatusTiles status={status} />

      {!canManage && <div className="mt-5 flex items-center gap-2 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning" role="note"><Lock className="size-4" /> Only owners and admins can change routing.</div>}

      <fieldset disabled={!canManage} className="mt-8 min-w-0 space-y-6 border-0 p-0">
        <section aria-labelledby="mode-h">
          <h2 id="mode-h" className="mb-3 text-lg font-bold">How do calls reach StayDesk?</h2>
          <div className="grid gap-4 md:grid-cols-2" role="radiogroup" aria-label="Connection mode">
            {modes.map((m) => {
              const on = draft.mode === m.value;
              return (
                <button key={m.value} type="button" role="radio" aria-checked={on} onClick={() => set({ mode: m.value })}
                  className={cn("rounded-2xl border-2 p-5 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-brand-400", on ? "border-brand-500 bg-brand-50 shadow-card" : "border-border bg-surface hover:border-brand-300")}>
                  <div className="mb-2 flex items-center gap-2"><Badge tone={on ? "brand" : "neutral"}>{m.tag}</Badge>{on && <span className="text-xs font-bold text-brand-700">Selected</span>}</div>
                  <p className="text-base font-bold">{m.title}</p>
                  <p className="mt-1 text-sm text-muted">{m.text}</p>
                </button>
              );
            })}
          </div>
        </section>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><PhoneCall className="size-[18px] text-brand-600" /> {draft.mode === "new_twilio" ? "Your Twilio number" : "StayDesk number & existing number"}</CardTitle>
            <CardDescription>Buy or choose a voice-capable number in the Twilio Console, then enter it here in international format. Incoming calls are matched to your business by this number.</CardDescription></CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Twilio / StayDesk number" htmlFor="r-twilio" hint="e.g. +14155550123"><Input id="r-twilio" type="tel" value={draft.twilioNumber ?? ""} onChange={(e) => set({ twilioNumber: e.target.value })} placeholder="+1 415 555 0123" /></Field>
              {draft.mode === "existing_number" && <Field label="Your existing business number" htmlFor="r-existing" hint="The number customers already call."><Input id="r-existing" type="tel" value={draft.existingNumber} onChange={(e) => set({ existingNumber: e.target.value })} placeholder="+1 805 555 0100" /></Field>}
            </div>

            {draft.mode === "existing_number" && (
              <div className="space-y-5">
                <ForwardingDiagram />
                <div className="rounded-2xl border border-border bg-brand-50/50 p-5 text-sm">
                  <p className="font-bold">Set up conditional call forwarding on your existing line</p>
                  <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted">
                    <li>Sign in to your phone provider (or dial the codes from your business phone).</li>
                    <li>Forward <b className="text-foreground">busy</b> and <b className="text-foreground">no-answer</b> calls to your StayDesk number{draft.twilioNumber ? <> (<b className="text-foreground">{draft.twilioNumber}</b>)</> : ""}. Optionally forward <b className="text-foreground">unreachable</b> too.</li>
                    <li>Set the ring time to roughly the “ring human for” seconds below, so staff get first chance.</li>
                    <li>Call your business number from another phone and let it ring, then confirm StayDesk answers.</li>
                  </ol>
                  <p className="mt-4 rounded-lg bg-surface px-3.5 py-2.5 font-mono text-[12.5px] text-muted">
                    Common GSM codes: busy <b className="text-foreground">**67*NUMBER#</b> · no-answer <b className="text-foreground">**61*NUMBER#</b> · unreachable <b className="text-foreground">**62*NUMBER#</b> · cancel all <b className="text-foreground">##002#</b>
                  </p>
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-muted"><Info className="mt-0.5 size-3.5 shrink-0" /> Codes differ between carriers and VoIP/PBX systems. Check your provider’s documentation. You authorize forwarding on your own account; no carrier partnership is needed.</p>
                </div>
                <ToggleRow title="I’ve set up forwarding" description="Marks “Forwarding configured” once you’ve completed and tested the steps above." checked={draft.forwardingConfigured} onCheckedChange={(v) => set({ forwardingConfigured: v })} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Settings2 className="size-[18px] text-brand-600" /> Routing rules</CardTitle>
            <CardDescription>{draft.mode === "existing_number" ? "Your carrier decides when to forward, and every forwarded call goes to the AI. Human transfer settings below still apply." : "Your team gets the first chance to answer. StayDesk takes over when they can’t."}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border">
            <ToggleRow title="Agent active" description="Turn off to make this number behave like a plain phone line (rings your team only)." checked={draft.agentActive} onCheckedChange={(v) => set({ agentActive: v })} />
            <ToggleRow title="AI-only mode" description="Skip the human-first ring. StayDesk answers every call immediately." checked={draft.aiOnly} onCheckedChange={(v) => set({ aiOnly: v })} />
            <div className={cn("divide-y divide-border", !humanRules && "pointer-events-none opacity-50")} aria-disabled={!humanRules}>
              <ToggleRow title="Human-first" description="Ring your team before the AI answers." checked={draft.humanFirst} onCheckedChange={(v) => set({ humanFirst: v })} />
              <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div><p className="text-sm font-semibold">Ring human for</p><p className="text-[13px] text-muted">Seconds before giving up and moving on (5–60).</p></div>
                <div className="flex items-center gap-2"><Input type="number" min={5} max={60} value={draft.ringSeconds} onChange={(e) => set({ ringSeconds: Number(e.target.value) })} className="h-9 w-24" aria-label="Ring seconds" /><span className="text-sm text-muted">sec</span></div>
              </div>
              <ToggleRow title="No answer → AI" description="If nobody picks up in time, the AI takes the call." checked={draft.noAnswerToAi} onCheckedChange={(v) => set({ noAnswerToAi: v })} />
              <ToggleRow title="Busy → AI" description="If the line is busy, the AI takes the call." checked={draft.busyToAi} onCheckedChange={(v) => set({ busyToAi: v })} />
              <ToggleRow title="Overflow → AI" description="If staff are already on calls, new callers go straight to the AI." checked={draft.overflowToAi} onCheckedChange={(v) => set({ overflowToAi: v })} />
              {draft.overflowToAi && (
                <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div><p className="text-sm font-semibold">Overflow after</p><p className="text-[13px] text-muted">Simultaneous staff calls before new calls overflow.</p></div>
                  <Input type="number" min={1} max={50} value={draft.maxConcurrentHumanCalls} onChange={(e) => set({ maxConcurrentHumanCalls: Number(e.target.value) })} className="h-9 w-24" aria-label="Max concurrent human calls" />
                </div>
              )}
            </div>
            <ToggleRow title="After-hours → AI" description="Outside your opening hours (Business knowledge), the AI answers immediately." checked={draft.afterHoursToAi} onCheckedChange={(v) => set({ afterHoursToAi: v })} />
            <div className="grid gap-4 py-4 sm:grid-cols-2">
              <Field label="Human transfer destination" htmlFor="r-human" hint="Rung first (human-first) and used when a caller asks for a person. Leave blank to use the business escalation number."><Input id="r-human" type="tel" value={draft.humanNumber} onChange={(e) => set({ humanNumber: e.target.value })} placeholder="+1 805 555 0100" /></Field>
              <Field label="Voice agent provider" hint={draft.voiceProvider === "twilio_gather" ? "Built in: speech-to-text on the call, then your AI. Works with just Twilio + OpenAI." : "External provider (experimental). Needs VOICE_SIP_URI and webhooks configured. See the README."}>
                <Select value={draft.voiceProvider} onValueChange={(v) => set({ voiceProvider: v as Draft["voiceProvider"] })} aria-label="Voice provider"
                  options={[{ value: "twilio_gather", label: "StayDesk built-in (Twilio speech)" }, { value: "retell", label: "Retell AI (experimental)" }, { value: "vapi", label: "Vapi (experimental)" }]} />
              </Field>
            </div>
          </CardContent>
        </Card>
      </fieldset>

      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="size-[18px] text-brand-600" /> Twilio webhook setup</CardTitle>
          <CardDescription>In the Twilio Console, open your number → Voice Configuration, and paste these. Use your public ngrok URL while developing (set <code>PUBLIC_BASE_URL</code>).</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <CopyField label="A call comes in · Webhook · HTTP POST" value={data.webhooks.incoming} />
          <CopyField label="Call status changes · Status callback URL · HTTP POST" value={data.webhooks.status} />
          <div className="flex flex-wrap gap-2 pt-1 text-xs">
            <Badge tone={data.integrations.twilio ? "success" : "warning"}>Twilio credentials {data.integrations.twilio ? "configured" : "not set"}</Badge>
            <Badge tone={data.integrations.openai ? "success" : "neutral"}>{data.integrations.openai ? "OpenAI agent" : "Built-in rule agent (no OPENAI_API_KEY)"}</Badge>
            <Badge tone={data.integrations.email ? "success" : "neutral"}>Email alerts {data.integrations.email ? "on" : "off (no RESEND_API_KEY)"}</Badge>
          </div>
        </CardContent>
      </Card>

      {canManage && (
        <div className="sticky bottom-4 z-10 mt-8 flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface/95 px-5 py-3.5 shadow-[0_8px_30px_rgb(29_22_51/0.12)] backdrop-blur">
          <p className="text-sm text-muted">{dirty ? <span className="font-semibold text-foreground">You have unsaved changes</span> : "All changes saved"}</p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!dirty || saving} onClick={() => setDraft(JSON.parse(saved))}>Discard</Button>
            <Button onClick={save} loading={saving} disabled={!dirty}><Save /> Save routing</Button>
          </div>
        </div>
      )}
    </>
  );
}
