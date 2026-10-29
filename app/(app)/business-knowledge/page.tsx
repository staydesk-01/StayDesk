"use client";
import * as React from "react";
import { BookOpenCheck, CheckCircle2, Circle, Lock, Save, ShieldCheck } from "lucide-react";
import { ContactsEditor, FaqEditor, ServicesEditor } from "@/components/knowledge/list-editors";
import { RoomsEditor } from "@/components/knowledge/rooms-editor";
import { HoursEditor } from "@/components/knowledge/hours-editor";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { useUpdateGuard } from "@/hooks/use-update-guard";
import { api, errorMessage } from "@/lib/api";
import { timezoneOptions } from "@/lib/constants";
import { businessTypeLabel } from "@/lib/format";
import type { Business, BusinessType, Knowledge } from "@/types";

interface Draft {
  business: Pick<Business, "name" | "type" | "phone" | "address" | "timezone" | "language" | "agentName" | "escalationPhone">;
  knowledge: Pick<Knowledge, "description" | "hours" | "services" | "faqs" | "pricingInfo" | "policies" | "escalationContacts">;
}

const pick = <T extends object, K extends keyof T>(o: T, keys: K[]) => Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;
const typeOptions = Object.entries(businessTypeLabel).map(([value, label]) => ({ value, label }));

const makeDraft = (business: Business, knowledge: Knowledge): Draft => ({
  business: pick(business, ["name", "type", "phone", "address", "timezone", "language", "agentName", "escalationPhone"]),
  knowledge: pick(knowledge, ["description", "hours", "services", "faqs", "pricingInfo", "policies", "escalationContacts"]),
});

export default function BusinessKnowledgePage() {
  const biz = useApi<{ business: Business }>("/business");
  const kn = useApi<{ knowledge: Knowledge }>("/knowledge");
  if ((biz.error || kn.error) && !(biz.data && kn.data)) {
    return <Card><ErrorState message={biz.error ?? kn.error ?? ""} onRetry={() => { void biz.reload(); void kn.reload(); }} /></Card>;
  }
  if (!biz.data || !kn.data) return <div className="space-y-5"><Skeleton className="h-24" /><Skeleton className="h-96" /></div>;
  return <KnowledgeForm business={biz.data.business} knowledge={kn.data.knowledge} />;
}

function KnowledgeForm({ business, knowledge }: { business: Business; knowledge: Knowledge }) {
  const { toast } = useToast();
  const { canManage, refresh } = useSession();
  const [draft, setDraft] = React.useState<Draft>(() => makeDraft(business, knowledge));
  const [saved, setSaved] = React.useState(() => JSON.stringify(makeDraft(business, knowledge)));
  const [saving, setSaving] = React.useState(false);

  const dirty = JSON.stringify(draft) !== saved;
  useUpdateGuard("unsaved", dirty);
  const tzOptions = React.useMemo(() => timezoneOptions(draft.business.timezone), [draft.business.timezone]);

  async function save() {
    setSaving(true);
    try {
      const clean = {
        ...draft.knowledge,
        services: draft.knowledge.services.filter((s) => s.name.trim()),
        faqs: draft.knowledge.faqs.filter((f) => f.question.trim() && f.answer.trim()),
        escalationContacts: draft.knowledge.escalationContacts.filter((c) => c.name.trim() && c.phone.trim()),
      };
      await Promise.all([api("/business", { method: "PATCH", body: draft.business }), api("/knowledge", { method: "PATCH", body: clean })]);
      const next = { business: draft.business, knowledge: clean };
      setDraft(next);
      setSaved(JSON.stringify(next));
      toast("Business knowledge saved. Your agent is using it now.");
      void refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  }

  const { business: b, knowledge: k } = draft;
  const setB = (p: Partial<Draft["business"]>) => setDraft({ ...draft, business: { ...b, ...p } });
  const setK = (p: Partial<Draft["knowledge"]>) => setDraft({ ...draft, knowledge: { ...k, ...p } });

  const checks = [
    { label: "Business description", ok: !!k.description.trim() },
    { label: "Opening hours", ok: Object.values(k.hours).some((d) => !d.closed) },
    { label: "Services", ok: k.services.some((s) => s.name.trim()) },
    { label: "FAQs", ok: k.faqs.filter((f) => f.question.trim()).length >= 3 },
    { label: "Policies", ok: !!k.policies.trim() },
    { label: "Human escalation number", ok: !!b.escalationPhone.trim() },
  ];
  const ready = checks.filter((c) => c.ok).length;

  return (
    <>
      <PageHeader title="Business knowledge" description="The verified information your agent speaks from. It answers only from what’s here and never makes things up." />

      <div className="mb-6 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex items-start gap-4 rounded-2xl border border-brand-200 bg-brand-100/60 p-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface shadow-card"><ShieldCheck className="size-6 text-brand-600" /></span>
          <div className="text-sm">
            <p className="text-base font-bold">Verified answers only</p>
            <p className="mt-1 text-muted">If a caller asks something that isn’t covered here, the agent says it doesn’t have that information and offers a callback instead of guessing. The more complete this page is, the more calls it can fully handle.</p>
          </div>
        </div>
        <Card className="p-5">
          <p className="flex items-center justify-between text-sm font-bold">Agent readiness <span className="text-brand-700">{ready}/{checks.length}</span></p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-brand-100" role="progressbar" aria-valuenow={ready} aria-valuemin={0} aria-valuemax={checks.length}>
            <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${(ready / checks.length) * 100}%` }} />
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-muted">
            {checks.map((c) => <li key={c.label} className="flex items-center gap-1.5">{c.ok ? <CheckCircle2 className="size-3.5 shrink-0 text-success" /> : <Circle className="size-3.5 shrink-0 text-subtle" />}{c.label}</li>)}
          </ul>
        </Card>
      </div>

      {!canManage && (
        <div className="mb-5 flex items-center gap-2 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning" role="note"><Lock className="size-4" /> Only owners and admins can edit business knowledge.</div>
      )}

      <fieldset disabled={!canManage} className="min-w-0 border-0 p-0">
        <Tabs defaultValue="business">
          <TabsList aria-label="Knowledge sections">
            <TabsTrigger value="business">Business</TabsTrigger>
            <TabsTrigger value="hours">Opening hours</TabsTrigger>
            <TabsTrigger value="services">Services & pricing</TabsTrigger>
            <TabsTrigger value="rooms">Rooms &amp; availability</TabsTrigger>
            <TabsTrigger value="faqs">FAQs</TabsTrigger>
            <TabsTrigger value="policies">Policies</TabsTrigger>
            <TabsTrigger value="escalation">Escalation</TabsTrigger>
          </TabsList>

          <TabsContent value="business">
            <Card>
              <CardHeader><CardTitle>About the business</CardTitle><CardDescription>Basics the agent uses to introduce itself and answer “where are you?”.</CardDescription></CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Business name" htmlFor="k-name"><Input id="k-name" value={b.name} onChange={(e) => setB({ name: e.target.value })} /></Field>
                  <Field label="Business type"><Select value={b.type} onValueChange={(v) => setB({ type: v as BusinessType })} options={typeOptions} aria-label="Business type" /></Field>
                  <Field label="Business phone" htmlFor="k-phone"><Input id="k-phone" type="tel" value={b.phone} onChange={(e) => setB({ phone: e.target.value })} placeholder="+1 555 010 0100" /></Field>
                  <Field label="Time zone" hint="Used for opening hours and after-hours routing."><Select value={b.timezone} onValueChange={(v) => setB({ timezone: v })} options={tzOptions} aria-label="Time zone" /></Field>
                  <Field label="Call language" hint="Non-English calls need the OpenAI agent (OPENAI_API_KEY); otherwise the built-in agent speaks English."><Select value={b.language ?? "en-US"} onValueChange={(v) => setB({ language: v as typeof b.language })} aria-label="Call language" options={[{ value: "en-US", label: "English" }, { value: "es-US", label: "Spanish" }, { value: "fr-FR", label: "French" }, { value: "de-DE", label: "German" }, { value: "pt-BR", label: "Portuguese" }]} /></Field>
                  <Field label="Address" htmlFor="k-address" className="sm:col-span-2"><Input id="k-address" value={b.address} onChange={(e) => setB({ address: e.target.value })} placeholder="218 Ocean Avenue, Santa Barbara, CA" /></Field>
                  <Field label="Agent name" htmlFor="k-agent" hint="How the AI introduces itself on calls."><Input id="k-agent" value={b.agentName} onChange={(e) => setB({ agentName: e.target.value })} /></Field>
                </div>
                <Field label="Business description" htmlFor="k-desc" hint="A few sentences on what makes your business special."><Textarea id="k-desc" value={k.description} onChange={(e) => setK({ description: e.target.value })} className="min-h-32" /></Field>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="hours">
            <Card>
              <CardHeader><CardTitle>Opening hours</CardTitle><CardDescription>Times are in {b.timezone.replace(/_/g, " ")}. Outside these hours, calls go straight to the AI when “After-hours → AI” is on.</CardDescription></CardHeader>
              <CardContent><HoursEditor value={k.hours} onChange={(hours) => setK({ hours })} /></CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="services">
            <div className="space-y-5">
              <Card>
                <CardHeader><CardTitle>Services</CardTitle><CardDescription>What you offer, with prices the agent may quote. Leave price blank if it varies.</CardDescription></CardHeader>
                <CardContent><ServicesEditor value={k.services} onChange={(services) => setK({ services })} /></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Pricing information</CardTitle><CardDescription>General pricing guidance, seasonal notes, deposits.</CardDescription></CardHeader>
                <CardContent><Textarea value={k.pricingInfo} onChange={(e) => setK({ pricingInfo: e.target.value })} className="min-h-28" aria-label="Pricing information" /></CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="rooms">
            <RoomsEditor />
          </TabsContent>

          <TabsContent value="faqs">
            <Card>
              <CardHeader><CardTitle>Frequently asked questions</CardTitle><CardDescription>Approved answers. The agent uses these word for word.</CardDescription></CardHeader>
              <CardContent><FaqEditor value={k.faqs} onChange={(faqs) => setK({ faqs })} /></CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="policies">
            <Card>
              <CardHeader><CardTitle>Policies</CardTitle><CardDescription>Check-in and check-out, cancellation, pets, deposits, house rules.</CardDescription></CardHeader>
              <CardContent><Textarea value={k.policies} onChange={(e) => setK({ policies: e.target.value })} className="min-h-48" aria-label="Policies" /></CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="escalation">
            <div className="space-y-5">
              <Card>
                <CardHeader><CardTitle>Human escalation number</CardTitle><CardDescription>When a caller asks for a person, the agent rings this number and bridges the call.</CardDescription></CardHeader>
                <CardContent><Field label="Phone number" htmlFor="k-esc"><Input id="k-esc" type="tel" value={b.escalationPhone} onChange={(e) => setB({ escalationPhone: e.target.value })} placeholder="+1 555 010 0100" className="max-w-sm" /></Field></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Other contacts</CardTitle><CardDescription>Reference contacts for your team (not dialed automatically in this version).</CardDescription></CardHeader>
                <CardContent><ContactsEditor value={k.escalationContacts} onChange={(escalationContacts) => setK({ escalationContacts })} /></CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </fieldset>

      {canManage && (
        <div className="sticky bottom-4 z-10 mt-8 flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface/95 px-5 py-3.5 shadow-[0_8px_30px_rgb(29_22_51/0.12)] backdrop-blur">
          <p className="flex items-center gap-2 text-sm text-muted">
            <BookOpenCheck className="size-4 text-brand-600" />
            {dirty ? <span className="font-semibold text-foreground">You have unsaved changes</span> : "All changes saved"}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!dirty || saving} onClick={() => setDraft(JSON.parse(saved))}>Discard</Button>
            <Button onClick={save} loading={saving} disabled={!dirty}><Save /> Save changes</Button>
          </div>
        </div>
      )}
    </>
  );
}
