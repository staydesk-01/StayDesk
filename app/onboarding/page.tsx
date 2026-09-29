"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Rocket } from "lucide-react";
import { Logo } from "@/components/common/logo";
import { InlineError } from "@/components/common/states";
import { HoursEditor } from "@/components/knowledge/hours-editor";
import { ContactsEditor, FaqEditor, ServicesEditor } from "@/components/knowledge/list-editors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleRow } from "@/components/ui/switch";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";
import { DEFAULT_HOURS, timezoneOptions } from "@/lib/constants";
import { businessTypeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Business, BusinessType, Knowledge } from "@/types";

const STEPS = ["Business", "Hours", "Services", "FAQs & policies", "Alerts"];
const typeOptions = Object.entries(businessTypeLabel).map(([value, label]) => ({ value, label }));

export default function OnboardingPage() {
  const biz = useApi<{ business: Business }>("/business");
  const kn = useApi<{ knowledge: Knowledge }>("/knowledge");
  if (!biz.data || !kn.data) return <div className="mx-auto max-w-3xl space-y-5 px-5 py-14"><Skeleton className="h-10 w-48" /><Skeleton className="h-96" /></div>;
  return <Wizard business={biz.data.business} knowledge={kn.data.knowledge} />;
}

function Wizard({ business, knowledge }: { business: Business; knowledge: Knowledge }) {
  const router = useRouter();
  const { session, refresh } = useSession();
  const [step, setStep] = React.useState(0);
  const [b, setB] = React.useState<Business>(() => {
    let timezone = business.timezone;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
    } catch { /* keep default */ }
    return { ...business, timezone };
  });
  const [k, setK] = React.useState<Knowledge>({ ...knowledge, hours: knowledge.hours ?? DEFAULT_HOURS });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const setBiz = (p: Partial<Business>) => setB({ ...b, ...p });
  const setKn = (p: Partial<Knowledge>) => setK({ ...k, ...p });
  const last = step === STEPS.length - 1;

  async function finish(skipped = false) {
    setBusy(true);
    setError("");
    try {
      if (!skipped) {
        const clean = {
          description: k.description, hours: k.hours, pricingInfo: k.pricingInfo, policies: k.policies,
          services: k.services.filter((s) => s.name.trim()),
          faqs: k.faqs.filter((f) => f.question.trim() && f.answer.trim()),
          escalationContacts: k.escalationContacts.filter((c) => c.name.trim() && c.phone.trim()),
        };
        await api("/knowledge", { method: "PATCH", body: clean });
      }
      await api("/business", {
        method: "PATCH",
        body: { name: b.name, type: b.type, phone: b.phone, address: b.address, timezone: b.timezone, escalationPhone: b.escalationPhone, ownerEmail: b.ownerEmail, notificationPrefs: b.notificationPrefs, onboardingComplete: true },
      });
      await refresh();
      router.replace("/overview");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="flex items-center justify-between border-b border-border bg-surface px-5 py-4 sm:px-10">
        <Logo />
        <button onClick={() => void finish(true)} className="text-sm font-semibold text-muted hover:text-brand-700" disabled={busy}>Skip for now</button>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-10 sm:py-14">
        <p className="text-[11px] font-bold tracking-[0.2em] text-muted uppercase">Set up {session.business.name}</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Let’s teach your agent about your business</h1>
        <p className="mt-2.5 text-muted">Takes about five minutes. Your agent only ever answers from what you enter here, and you can change it any time.</p>

        <ol className="mt-8 flex gap-2 overflow-x-auto pb-1" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} className="flex flex-1 basis-0 min-w-24 flex-col gap-1.5" aria-current={i === step ? "step" : undefined}>
              <span className={cn("h-1.5 rounded-full transition-colors", i <= step ? "bg-brand-600" : "bg-brand-100")} />
              <span className={cn("flex items-center gap-1.5 text-xs font-semibold", i === step ? "text-brand-800" : "text-muted")}>{i < step ? <Check className="size-3.5 text-success" /> : <span>{i + 1}.</span>} {s}</span>
            </li>
          ))}
        </ol>

        <Card className="mt-6">
          {step === 0 && (
            <>
              <CardHeader><CardTitle>About your business</CardTitle><CardDescription>The basics your agent will use.</CardDescription></CardHeader>
              <CardContent className="grid gap-5 sm:grid-cols-2">
                <Field label="Business name" htmlFor="o-name"><Input id="o-name" value={b.name} onChange={(e) => setBiz({ name: e.target.value })} /></Field>
                <Field label="Business type"><Select value={b.type} onValueChange={(v) => setBiz({ type: v as BusinessType })} options={typeOptions} aria-label="Business type" /></Field>
                <Field label="Business phone" htmlFor="o-phone"><Input id="o-phone" type="tel" value={b.phone} onChange={(e) => setBiz({ phone: e.target.value })} placeholder="+1 555 010 0100" /></Field>
                <Field label="Time zone"><Select value={b.timezone} onValueChange={(v) => setBiz({ timezone: v })} options={timezoneOptions(b.timezone)} aria-label="Time zone" /></Field>
                <Field label="Address" htmlFor="o-addr" className="sm:col-span-2"><Input id="o-addr" value={b.address} onChange={(e) => setBiz({ address: e.target.value })} placeholder="Street, city, state" /></Field>
                <Field label="Short description" htmlFor="o-desc" className="sm:col-span-2" hint="Optional. A few sentences about what you offer."><Textarea id="o-desc" value={k.description} onChange={(e) => setKn({ description: e.target.value })} /></Field>
              </CardContent>
            </>
          )}
          {step === 1 && (
            <>
              <CardHeader><CardTitle>Opening hours</CardTitle><CardDescription>Outside these hours, calls can go straight to the AI.</CardDescription></CardHeader>
              <CardContent><HoursEditor value={k.hours} onChange={(hours) => setKn({ hours })} /></CardContent>
            </>
          )}
          {step === 2 && (
            <>
              <CardHeader><CardTitle>Services & pricing</CardTitle><CardDescription>What callers ask about most, with prices you’re happy for the agent to share.</CardDescription></CardHeader>
              <CardContent className="space-y-5">
                <ServicesEditor value={k.services} onChange={(services) => setKn({ services })} />
                <Field label="General pricing information" htmlFor="o-pricing" hint="Optional: seasonal rates, deposits, “prices vary”…"><Textarea id="o-pricing" value={k.pricingInfo} onChange={(e) => setKn({ pricingInfo: e.target.value })} /></Field>
              </CardContent>
            </>
          )}
          {step === 3 && (
            <>
              <CardHeader><CardTitle>FAQs & policies</CardTitle><CardDescription>Approved answers to common questions.</CardDescription></CardHeader>
              <CardContent className="space-y-5">
                <FaqEditor value={k.faqs} onChange={(faqs) => setKn({ faqs })} />
                <Field label="Policies" htmlFor="o-policies" hint="Check-in/out, cancellation, pets, deposits…"><Textarea id="o-policies" value={k.policies} onChange={(e) => setKn({ policies: e.target.value })} className="min-h-32" /></Field>
              </CardContent>
            </>
          )}
          {step === 4 && (
            <>
              <CardHeader><CardTitle>Escalation & alerts</CardTitle><CardDescription>Where transfers ring and how we notify you.</CardDescription></CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Human escalation phone" htmlFor="o-esc" hint="Rung when a caller asks for a person."><Input id="o-esc" type="tel" value={b.escalationPhone} onChange={(e) => setBiz({ escalationPhone: e.target.value })} placeholder="+1 555 010 0100" /></Field>
                  <Field label="Owner email" htmlFor="o-email" hint="Alerts are sent here."><Input id="o-email" type="email" value={b.ownerEmail} onChange={(e) => setBiz({ ownerEmail: e.target.value })} /></Field>
                </div>
                <div className="divide-y divide-border">
                  <ToggleRow title="In-app notifications" description="Live alerts in your dashboard." checked={b.notificationPrefs.inApp} onCheckedChange={(v) => setBiz({ notificationPrefs: { ...b.notificationPrefs, inApp: v } })} />
                  <ToggleRow title="Email alerts" description="New leads, urgent requests and failed transfers." checked={b.notificationPrefs.email} onCheckedChange={(v) => setBiz({ notificationPrefs: { ...b.notificationPrefs, email: v } })} />
                </div>
                <div>
                  <p className="mb-2 text-sm font-semibold">Other contacts (optional)</p>
                  <ContactsEditor value={k.escalationContacts} onChange={(escalationContacts) => setKn({ escalationContacts })} />
                </div>
              </CardContent>
            </>
          )}
          <div className="px-5 pb-6 sm:px-6">
            <InlineError message={error} />
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0 || busy}><ArrowLeft /> Back</Button>
              {last ? (
                <Button size="lg" loading={busy} onClick={() => void finish()}><Rocket /> Finish setup</Button>
              ) : (
                <Button size="lg" onClick={() => setStep((s) => s + 1)} disabled={step === 0 && !b.name.trim()}>Continue <ArrowRight /></Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
