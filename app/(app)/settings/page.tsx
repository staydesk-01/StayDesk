"use client";
import * as React from "react";
import { AlertTriangle, LogOut, Plus, Save, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState, InlineError } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field } from "@/components/ui/label";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch, ToggleRow } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { useUpdateGuard } from "@/hooks/use-update-guard";
import { api, errorMessage } from "@/lib/api";
import type { Business, NotificationType, Role, TeamMember } from "@/types";

const EVENTS: { value: NotificationType; label: string; hint: string }[] = [
  { value: "high_value_lead", label: "New high-value lead", hint: "An opportunity above your threshold" },
  { value: "booking_inquiry", label: "Booking inquiry", hint: "A caller asked to book or schedule" },
  { value: "urgent_request", label: "Urgent customer request", hint: "Emergencies and time-sensitive issues" },
  { value: "transfer_failed", label: "Human transfer failed", hint: "A caller asked for a person and nobody answered" },
  { value: "callback_requested", label: "Customer requested a callback", hint: "Someone wants to be called back" },
  { value: "unresolved_request", label: "AI couldn’t resolve a request", hint: "Needs a human to take a look" },
];
const ROLE_OPTIONS = [{ value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "staff", label: "Staff" }];

export default function SettingsPage() {
  const biz = useApi<{ business: Business }>("/business");
  if (biz.error && !biz.data) return <Card><ErrorState message={biz.error} onRetry={() => void biz.reload()} /></Card>;
  if (!biz.data) return <div className="space-y-5"><Skeleton className="h-12 w-80" /><Skeleton className="h-96" /></div>;
  return <SettingsView initial={biz.data.business} />;
}

function SaveBar({ visible, dirty, saving, onSave, onDiscard }: { visible: boolean; dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void }) {
  if (!visible) return null;
  return (
    <div className="mt-6 flex items-center justify-end gap-3">
      {dirty && <span className="text-sm font-semibold">Unsaved changes</span>}
      <Button variant="outline" disabled={!dirty || saving} onClick={onDiscard}>Discard</Button>
      <Button onClick={onSave} loading={saving} disabled={!dirty}><Save /> Save settings</Button>
    </div>
  );
}

function SettingsView({ initial }: { initial: Business }) {
  const { toast } = useToast();
  const { session, canManage, logout, refresh } = useSession();
  const team = useApi<{ users: TeamMember[] }>("/team");
  const [base, setBase] = React.useState(initial);
  const [b, setB] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const [member, setMember] = React.useState({ name: "", email: "", password: "", role: "staff" as Role });
  const [memberError, setMemberError] = React.useState("");

  const dirty = JSON.stringify(b) !== JSON.stringify(base);
  useUpdateGuard("unsaved", dirty);
  const setPrefs = (p: Partial<Business["notificationPrefs"]>) => setB({ ...b, notificationPrefs: { ...b.notificationPrefs, ...p } });
  const setPrivacy = (p: Partial<Business["privacy"]>) => setB({ ...b, privacy: { ...b.privacy, ...p } });

  async function save() {
    setSaving(true);
    try {
      const { name, agentName, ownerEmail, notificationPrefs, privacy } = b;
      const res = await api<{ business: Business }>("/business", { method: "PATCH", body: { name, agentName, ownerEmail, notificationPrefs, privacy } });
      setBase(res.business);
      setB(res.business);
      toast("Settings saved");
      void refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setMemberError("");
    try {
      await api("/team", { method: "POST", body: member });
      toast(`${member.name} added to your team`);
      setInviting(false);
      setMember({ name: "", email: "", password: "", role: "staff" });
      await team.refetch();
    } catch (err) {
      setMemberError(errorMessage(err));
    }
  }

  async function updateMember(id: string, body: Partial<Pick<TeamMember, "role" | "active">>) {
    try {
      await api(`/team/${id}`, { method: "PATCH", body });
      await team.refetch();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Notifications, privacy and your team." />
      <Tabs defaultValue="notifications">
        <TabsList aria-label="Settings sections">
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="privacy">Privacy & recording</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
        </TabsList>

        <TabsContent value="notifications">
          <fieldset disabled={!canManage} className="min-w-0 border-0 p-0">
            <Card>
              <CardHeader><CardTitle>Owner alerts</CardTitle><CardDescription>How and when StayDesk tells you about calls that need attention.</CardDescription></CardHeader>
              <CardContent className="divide-y divide-border">
                <ToggleRow title="In-app notifications" description="Shown in the bell at the top of the dashboard, live." checked={b.notificationPrefs.inApp} onCheckedChange={(v) => setPrefs({ inApp: v })} />
                <ToggleRow title="Email" description={`Sent to ${b.ownerEmail || "the owner email below"}. Requires RESEND_API_KEY on the server.`} checked={b.notificationPrefs.email} onCheckedChange={(v) => setPrefs({ email: v })} />
                <ToggleRow title="SMS" description="Coming soon." checked={false} onCheckedChange={() => {}} disabled />
                <div className="py-4">
                  <p className="mb-1 text-sm font-semibold">Alert me about</p>
                  <ul className="divide-y divide-border/60">
                    {EVENTS.map((ev) => (
                      <li key={ev.value} className="flex items-center justify-between gap-4 py-2.5">
                        <div><p className="text-sm font-medium">{ev.label}</p><p className="text-xs text-muted">{ev.hint}</p></div>
                        <Switch checked={b.notificationPrefs.events.includes(ev.value)} aria-label={ev.label}
                          onCheckedChange={(on) => setPrefs({ events: on ? [...b.notificationPrefs.events, ev.value] : b.notificationPrefs.events.filter((x) => x !== ev.value) })} />
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="grid gap-4 py-4 sm:grid-cols-2">
                  <Field label="Owner email" htmlFor="s-email"><Input id="s-email" type="email" value={b.ownerEmail} onChange={(e) => setB({ ...b, ownerEmail: e.target.value })} /></Field>
                  <Field label="High-value threshold (USD)" htmlFor="s-thr" hint="Opportunities at or above this estimated value trigger a high-value alert."><Input id="s-thr" type="number" min={0} value={b.notificationPrefs.highValueThreshold} onChange={(e) => setPrefs({ highValueThreshold: Number(e.target.value) })} /></Field>
                </div>
              </CardContent>
            </Card>
            <SaveBar visible={canManage} dirty={dirty} saving={saving} onSave={save} onDiscard={() => setB(base)} />
          </fieldset>
        </TabsContent>

        <TabsContent value="privacy">
          <fieldset disabled={!canManage} className="min-w-0 border-0 p-0">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-[18px] text-brand-600" /> Recording & retention</CardTitle><CardDescription>You’re in control of what StayDesk keeps about your callers.</CardDescription></CardHeader>
              <CardContent className="space-y-2 divide-y divide-border">
                <div>
                  <ToggleRow title="Record calls" description="Off by default. When on, StayDesk plays the disclosure below at the start of each AI call and saves a recording reference." checked={b.privacy.recordingEnabled} onCheckedChange={(v) => setPrivacy({ recordingEnabled: v })} />
                  {b.privacy.recordingEnabled && (
                    <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-warning-soft p-3.5 text-[13px] text-warning" role="note">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <p>Recording laws vary by state and country. Many places require consent from <b>all</b> parties. Confirm requirements with your legal advisor before turning this on.</p>
                    </div>
                  )}
                </div>
                <div className="py-4"><Field label="Recording disclosure" htmlFor="s-consent" hint="Spoken to every caller when recording is on."><Textarea id="s-consent" value={b.privacy.recordingConsentMessage} onChange={(e) => setPrivacy({ recordingConsentMessage: e.target.value })} className="min-h-20" /></Field></div>
                <div className="py-4"><Field label="Keep transcripts for (days)" htmlFor="s-ret" hint="Older transcripts are deleted automatically. You can also delete any call or transcript from its call page."><Input id="s-ret" type="number" min={1} max={3650} value={b.privacy.transcriptRetentionDays} onChange={(e) => setPrivacy({ transcriptRetentionDays: Number(e.target.value) })} className="max-w-40" /></Field></div>
              </CardContent>
            </Card>
            <SaveBar visible={canManage} dirty={dirty} saving={saving} onSave={save} onDiscard={() => setB(base)} />
          </fieldset>
        </TabsContent>

        <TabsContent value="team">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div><CardTitle>Team</CardTitle><CardDescription>Owners and admins manage settings. Staff work calls and follow-ups.</CardDescription></div>
              {canManage && <Button onClick={() => setInviting(true)}><Plus /> Add member</Button>}
            </CardHeader>
            <CardContent>
              {!team.data ? <Skeleton className="h-32" /> : (
                <ul className="divide-y divide-border">
                  {team.data.users.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-center gap-3 py-3.5">
                      <span className="grid size-10 place-items-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">{u.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}</span>
                      <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{u.name} {u.id === session.user.id && <Badge tone="brand">You</Badge>} {!u.active && <Badge tone="neutral">Deactivated</Badge>}</p><p className="truncate text-xs text-muted">{u.email}</p></div>
                      {canManage && u.id !== session.user.id ? (
                        <div className="flex items-center gap-3">
                          <Select className="h-9 w-32" value={u.role} onValueChange={(v) => updateMember(u.id, { role: v as Role })} options={ROLE_OPTIONS} aria-label={`Role for ${u.name}`} />
                          <Switch checked={u.active} onCheckedChange={(v) => updateMember(u.id, { active: v })} aria-label={`${u.name} active`} />
                        </div>
                      ) : <Badge tone="neutral" className="capitalize">{u.role}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="profile">
          <fieldset disabled={!canManage} className="min-w-0 border-0 p-0">
            <Card>
              <CardHeader><CardTitle>Workspace profile</CardTitle></CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Business name" htmlFor="p-name"><Input id="p-name" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
                  <Field label="Agent name" htmlFor="p-agent" hint="How the AI introduces itself."><Input id="p-agent" value={b.agentName} onChange={(e) => setB({ ...b, agentName: e.target.value })} /></Field>
                </div>
                <p className="text-sm text-muted">Business details, hours, services and FAQs live in Business knowledge. Phone numbers live in Call routing.</p>
              </CardContent>
            </Card>
            <SaveBar visible={canManage} dirty={dirty} saving={saving} onSave={save} onDiscard={() => setB(base)} />
          </fieldset>
          <Card className="mt-5">
            <CardHeader><CardTitle>Your account</CardTitle><CardDescription>{session.user.name} · {session.user.email} · <span className="capitalize">{session.user.role}</span></CardDescription></CardHeader>
            <CardContent><Button variant="outline" onClick={() => void logout()}><LogOut /> Sign out</Button></CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent title="Add a team member" description="They can sign in right away with the email and temporary password you set.">
          <form onSubmit={invite} className="space-y-4">
            <InlineError message={memberError} />
            <Field label="Full name" htmlFor="m-name"><Input id="m-name" required value={member.name} onChange={(e) => setMember({ ...member, name: e.target.value })} /></Field>
            <Field label="Email" htmlFor="m-email"><Input id="m-email" type="email" required value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} /></Field>
            <Field label="Temporary password" htmlFor="m-pw" hint="At least 8 characters."><Input id="m-pw" type="password" required minLength={8} autoComplete="new-password" value={member.password} onChange={(e) => setMember({ ...member, password: e.target.value })} /></Field>
            <Field label="Role"><Select value={member.role} onValueChange={(v) => setMember({ ...member, role: v as Role })} options={ROLE_OPTIONS.filter((r) => session.user.role === "owner" || r.value !== "owner")} aria-label="Role" /></Field>
            <div className="flex justify-end gap-2 pt-2"><DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose><Button type="submit">Add member</Button></div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
