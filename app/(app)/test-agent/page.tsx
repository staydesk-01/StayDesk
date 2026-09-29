"use client";
import * as React from "react";
import Link from "next/link";
import { Bot, CheckCircle2, CircleAlert, CircleDot, Mic, MicOff, Phone, PhoneOff, Send, Sparkles, UserRound, Volume2, VolumeX } from "lucide-react";
import { IntentBadge, OutcomeBadge } from "@/components/common/badges";
import { PageHeader } from "@/components/common/page-header";
import { InlineError } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/hooks/use-api";
import { useSpeech } from "@/hooks/use-speech";
import { api, errorMessage } from "@/lib/api";
import { formatMoney, routingLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CallAction, CallSummary, CallStatus, Intent, Opportunity, Outcome, RoutingReason, TransferStatus } from "@/types";

interface Status {
  agentName: string;
  brain: "openai" | "rules";
  agentActive: boolean;
  knowledge: { loaded: boolean; faqs: number; services: number; hasPolicies: boolean; hasPricing: boolean };
  integrations: { openai: boolean; twilio: boolean; email: boolean };
}
interface Snapshot { intent: Intent; status: CallStatus; outcome: Outcome; transferStatus: TransferStatus; actions: CallAction[]; endedAt?: string }
interface Msg { role: "agent" | "caller" | "system"; text: string }

const SUGGESTIONS = [
  "Hi, I'd like to book a deluxe king room this Friday for two nights, two guests",
  "What time is check-out and is breakfast included?",
  "I'm in room 214 and the air conditioning isn't working",
  "Can I speak to a real person?",
  "How much is an ocean view suite?",
];

export default function TestAgentPage() {
  const status = useApi<Status>("/test-agent/status");
  const [callId, setCallId] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [snap, setSnap] = React.useState<Snapshot | null>(null);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [ended, setEnded] = React.useState(false);
  const [result, setResult] = React.useState<{ summary: CallSummary | null; opportunities: Opportunity[]; followUps: number } | null>(null);
  const [opts, setOpts] = React.useState({ callerNumber: "+15550100123", routingReason: "no_answer" as RoutingReason, simulateTransferAnswers: false });
  const [speakReplies, setSpeakReplies] = React.useState(false);
  const scroller = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const send = React.useCallback(async (raw: string) => {
    const t = raw.trim();
    if (!t || !callId || busy || ended) return;
    setMsgs((m) => [...m, { role: "caller", text: t }]);
    setText("");
    setBusy(true);
    setError("");
    try {
      const res = await api<{ reply: string; ended: boolean; call: Snapshot }>(`/test-agent/sessions/${callId}/message`, { method: "POST", body: { text: t } });
      setMsgs((m) => [...m, { role: "agent", text: res.reply }]);
      setSnap(res.call);
      if (speakReplies) speech.speak(res.reply);
      if (res.ended) await finish(callId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, busy, ended, speakReplies]);

  const speech = useSpeech((t) => void send(t));

  React.useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  async function start() {
    setError("");
    setBusy(true);
    try {
      const res = await api<{ callId: string; greeting: string }>("/test-agent/sessions", { method: "POST", body: opts });
      setCallId(res.callId);
      setMsgs([{ role: "system", text: `Test call started · ${routingLabel[opts.routingReason]}` }, { role: "agent", text: res.greeting }]);
      setSnap(null);
      setEnded(false);
      setResult(null);
      if (speakReplies) speech.speak(res.greeting);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish(id: string) {
    speech.silence();
    try {
      const res = await api<{ call: Snapshot }>(`/test-agent/sessions/${id}/end`, { method: "POST" });
      const detail = await api<{ summary: CallSummary | null; opportunities: Opportunity[]; followUps: unknown[] }>(`/calls/${id}`);
      setSnap(res.call);
      setResult({ summary: detail.summary, opportunities: detail.opportunities, followUps: detail.followUps.length });
      setEnded(true);
      setMsgs((m) => [...m, { role: "system", text: "Call ended" }]);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const s = status.data;
  const active = !!callId && !ended;

  return (
    <>
      <PageHeader title="Test your agent" description="Have a conversation with your agent before connecting a real phone number. Test calls appear in Call activity, marked Test." />

      <div className="grid gap-5 xl:grid-cols-[320px_1fr_340px]">
        {/* Left: status & controls */}
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Voice agent</CardTitle></CardHeader>
            <CardContent className="space-y-3.5 text-sm">
              {!s ? <Skeleton className="h-28" /> : (
                <>
                  <Row label="Agent">{s.agentName}</Row>
                  <Row label="Status">{s.agentActive ? <Badge tone="success"><span className="sd-live-dot size-1.5 rounded-full bg-success" /> Ready</Badge> : <Badge tone="warning">Paused</Badge>}</Row>
                  <Row label="Reasoning">{s.brain === "openai" ? <Badge tone="brand"><Sparkles className="size-3" /> OpenAI</Badge> : <Badge tone="neutral">Built-in rules</Badge>}</Row>
                  <Row label="Mode"><Badge tone="info">Text{speech.supported ? " + browser voice" : ""}</Badge></Row>
                  {s.brain === "rules" && <p className="rounded-xl bg-brand-50 p-3 text-xs text-muted">No <code>OPENAI_API_KEY</code> is set, so the deterministic built-in agent is answering. Add a key to use the full AI model.</p>}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Business knowledge</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!s ? <Skeleton className="h-16" /> : s.knowledge.loaded ? (
                <>
                  <p className="flex items-center gap-2 font-semibold text-success"><CheckCircle2 className="size-4" /> Loaded</p>
                  <p className="text-muted">{s.knowledge.services} services · {s.knowledge.faqs} FAQs{s.knowledge.hasPolicies ? " · policies" : ""}{s.knowledge.hasPricing ? " · pricing" : ""}</p>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 font-semibold text-warning"><CircleAlert className="size-4" /> Not set up yet</p>
                  <p className="text-muted">Add FAQs and services so the agent has something to say.</p>
                </>
              )}
              <Link href="/business-knowledge" className="inline-block text-sm font-semibold text-brand-700 hover:underline">Edit business knowledge →</Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Test call</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Field label="Caller number" htmlFor="t-num"><Input id="t-num" type="tel" value={opts.callerNumber} onChange={(e) => setOpts({ ...opts, callerNumber: e.target.value })} disabled={active} /></Field>
              <Field label="Why did the call reach AI?">
                <Select value={opts.routingReason} disabled={active} onValueChange={(v) => setOpts({ ...opts, routingReason: v as RoutingReason })} aria-label="Routing reason"
                  options={(Object.keys(routingLabel) as RoutingReason[]).map((r) => ({ value: r, label: routingLabel[r] }))} />
              </Field>
              <label className="flex items-start justify-between gap-3 text-sm">
                <span><span className="block font-semibold">Staff answer a transfer</span><span className="text-[13px] text-muted">Off tests the “nobody answers” fallback.</span></span>
                <Switch checked={opts.simulateTransferAnswers} onCheckedChange={(v) => setOpts({ ...opts, simulateTransferAnswers: v })} disabled={active} aria-label="Staff answer a transfer" />
              </label>
              {active ? (
                <Button variant="danger" className="w-full" size="lg" onClick={() => callId && finish(callId)}><PhoneOff /> End test</Button>
              ) : (
                <Button className="w-full" size="lg" onClick={start} loading={busy && !callId}><Phone /> {ended ? "Start a new test" : "Start test"}</Button>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Center: live transcript */}
        <Card className="flex min-h-[34rem] flex-col xl:h-[calc(100dvh-14rem)] xl:min-h-[36rem]">
          <CardHeader className="flex-row items-center justify-between border-b border-border pb-4">
            <div>
              <CardTitle className="flex items-center gap-2">Live transcript {active && <span className="sd-live-dot size-2 rounded-full bg-brand-500" aria-label="Call in progress" />}</CardTitle>
              <CardDescription>{active ? "You’re the caller. Type or use the mic." : ended ? "This test call has ended." : "Start a test to begin the conversation."}</CardDescription>
            </div>
            {speech.supported && (
              <Button variant="ghost" size="sm" onClick={() => { setSpeakReplies((v) => !v); speech.silence(); }} aria-pressed={speakReplies}>
                {speakReplies ? <Volume2 /> : <VolumeX />} {speakReplies ? "Voice on" : "Voice off"}
              </Button>
            )}
          </CardHeader>
          <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto p-5 sm:p-6" aria-live="polite">
            {!msgs.length ? (
              <div className="grid h-full place-items-center text-center">
                <div><span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-brand-100 text-brand-700"><Bot className="size-7" /></span>
                  <p className="font-semibold">Ready when you are</p><p className="mt-1 max-w-xs text-sm text-muted">Press “Start test” and say hello, just as a customer would on the phone.</p></div>
              </div>
            ) : msgs.map((m, i) => m.role === "system" ? (
              <p key={i} className="text-center text-xs font-medium text-subtle">{m.text}</p>
            ) : (
              <div key={i} className={cn("flex gap-3", m.role === "caller" && "flex-row-reverse")}>
                <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-full", m.role === "agent" ? "bg-brand-100 text-brand-700" : "bg-info-soft text-info")}>{m.role === "agent" ? <Bot className="size-4" /> : <UserRound className="size-4" />}</span>
                <p className={cn("max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed", m.role === "agent" ? "rounded-tl-md bg-brand-50" : "rounded-tr-md bg-brand-600 text-white")}>{m.text}</p>
              </div>
            ))}
            {busy && callId && (
              <div className="flex gap-3" aria-label="Agent is typing">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700"><Bot className="size-4" /></span>
                <span className="flex items-center gap-1 rounded-2xl rounded-tl-md bg-brand-50 px-4 py-3">{[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-bounce rounded-full bg-brand-400" style={{ animationDelay: `${i * 0.15}s` }} />)}</span>
              </div>
            )}
          </div>
          <div className="border-t border-border p-4 sm:p-5">
            <InlineError message={error} />
            {active && (
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                {SUGGESTIONS.map((sug) => <button key={sug} onClick={() => send(sug)} disabled={busy} className="shrink-0 rounded-full border border-border-strong bg-surface px-3.5 py-1.5 text-xs font-semibold text-muted transition hover:border-brand-300 hover:text-brand-800 disabled:opacity-50">{sug.length > 44 ? `${sug.slice(0, 42)}…` : sug}</button>)}
              </div>
            )}
            <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="flex gap-2">
              {speech.supported && (
                <Button type="button" variant={speech.listening ? "danger" : "outline"} size="icon" className="size-10" disabled={!active || busy} onClick={() => (speech.listening ? speech.stop() : speech.listen())} aria-label={speech.listening ? "Stop listening" : "Speak"}>
                  {speech.listening ? <MicOff /> : <Mic />}
                </Button>
              )}
              <Input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={active ? "Type what the caller says…" : "Start a test call first"} disabled={!active || busy} aria-label="Message" />
              <Button type="submit" disabled={!active || busy || !text.trim()} aria-label="Send"><Send /></Button>
            </form>
          </div>
        </Card>

        {/* Right: intent, tools, summary */}
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Detected intent</CardTitle></CardHeader>
            <CardContent>{snap ? <div className="flex flex-wrap items-center gap-2"><IntentBadge intent={snap.intent} />{snap.transferStatus !== "none" && <Badge tone="warning">Transfer: {snap.transferStatus.replace("_", " ")}</Badge>}</div> : <p className="text-sm text-muted">Appears as the caller speaks.</p>}</CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Tool actions</CardTitle><CardDescription>What the agent did in your backend.</CardDescription></CardHeader>
            <CardContent>
              {!snap?.actions.length ? <p className="text-sm text-muted">No actions yet.</p> : (
                <ol className="space-y-3">
                  {snap.actions.map((a, i) => (
                    <li key={i} className="flex gap-2.5 text-sm">
                      {a.ok ? <CircleDot className="mt-0.5 size-4 shrink-0 text-brand-600" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />}
                      <div className="min-w-0"><p className="font-semibold">{a.tool.replace(/_/g, " ")}</p><p className="text-[13px] break-words text-muted">{a.summary}</p></div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Call summary</CardTitle></CardHeader>
            <CardContent>
              {!ended || !result ? <p className="text-sm text-muted">Generated when the call ends.</p> : (
                <div className="space-y-3 text-sm">
                  {snap && <OutcomeBadge outcome={snap.outcome} />}
                  <p className="leading-relaxed">{result.summary?.summary ?? "No summary was generated."}</p>
                  {!!result.opportunities.length && <p className="rounded-xl bg-brand-50 p-3 text-[13px]"><b>Opportunity:</b> {result.opportunities[0].details}{result.opportunities[0].estimatedValue ? ` · potential ${formatMoney(result.opportunities[0].estimatedValue)}` : ""}</p>}
                  {result.followUps > 0 && <p className="text-[13px] text-muted">{result.followUps} follow-up{result.followUps > 1 ? "s" : ""} created for your team.</p>}
                  {callId && <Button asChild variant="outline" size="sm" className="w-full"><Link href={`/calls/${callId}`}>Open call record</Link></Button>}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-3"><span className="text-muted">{label}</span><span className="font-semibold">{children}</span></div>
);
