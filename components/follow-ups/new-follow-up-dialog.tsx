"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field } from "@/components/ui/label";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { InlineError } from "@/components/common/states";
import { api, errorMessage } from "@/lib/api";
import { priorityLabel } from "@/lib/format";
import type { Priority } from "@/types";

const PRIORITIES = (Object.keys(priorityLabel) as Priority[]).map((p) => ({ value: p, label: priorityLabel[p] }));

export function NewFollowUpDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [form, setForm] = React.useState({ customerName: "", phone: "", reason: "", priority: "normal" as Priority, dueAt: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/follow-ups", { method: "POST", body: { ...form, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined } });
      setForm({ customerName: "", phone: "", reason: "", priority: "normal", dueAt: "" });
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New follow-up" description="Create a task for your team to call someone back or complete a request.">
        <form onSubmit={submit} className="space-y-4">
          <InlineError message={error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer name" htmlFor="fu-name"><Input id="fu-name" value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} /></Field>
            <Field label="Phone" htmlFor="fu-phone"><Input id="fu-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          </div>
          <Field label="What needs to happen?" htmlFor="fu-reason"><Textarea id="fu-reason" required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Call back with group pricing" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority"><Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v as Priority })} options={PRIORITIES} aria-label="Priority" /></Field>
            <Field label="Due (optional)" htmlFor="fu-due"><Input id="fu-due" type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
            <Button type="submit" loading={busy}>Create follow-up</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
