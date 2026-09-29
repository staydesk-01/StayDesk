"use client";
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import type { Knowledge } from "@/types";

function Row({ children, onRemove, label }: { children: React.ReactNode; onRemove: () => void; label: string }) {
  return (
    <li className="relative rounded-2xl border border-border bg-surface p-4 pr-12 sm:p-5 sm:pr-14">
      {children}
      <Button type="button" variant="ghost" size="icon" onClick={onRemove} className="absolute top-3 right-3 text-subtle hover:text-danger" aria-label={label}>
        <Trash2 />
      </Button>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-2xl border border-dashed border-border-strong px-5 py-8 text-center text-sm text-muted">{text}</p>;
}

export function ServicesEditor({ value, onChange }: { value: Knowledge["services"]; onChange: (v: Knowledge["services"]) => void }) {
  const set = (i: number, patch: Partial<Knowledge["services"][number]>) => onChange(value.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-3">
      {!value.length && <Empty text="No services yet. Add the rooms, treatments or services callers ask about." />}
      <ul className="space-y-3">
        {value.map((s, i) => (
          <Row key={i} onRemove={() => onChange(value.filter((_, idx) => idx !== i))} label={`Remove service ${s.name || i + 1}`}>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <Field label="Service name"><Input value={s.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Deluxe King Room" /></Field>
              <Field label="Price"><Input value={s.price} onChange={(e) => set(i, { price: e.target.value })} placeholder="From $189 per night" /></Field>
              <Field label="Description" className="sm:col-span-2"><Input value={s.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Queen or king bed, courtyard view, sleeps 2" /></Field>
            </div>
          </Row>
        ))}
      </ul>
      <Button type="button" variant="outline" onClick={() => onChange([...value, { name: "", description: "", price: "" }])}><Plus /> Add service</Button>
    </div>
  );
}

export function FaqEditor({ value, onChange }: { value: Knowledge["faqs"]; onChange: (v: Knowledge["faqs"]) => void }) {
  const set = (i: number, patch: Partial<Knowledge["faqs"][number]>) => onChange(value.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-3">
      {!value.length && <Empty text="No FAQs yet. Add the questions callers ask most: parking, check-in, cancellations…" />}
      <ul className="space-y-3">
        {value.map((f, i) => (
          <Row key={i} onRemove={() => onChange(value.filter((_, idx) => idx !== i))} label={`Remove FAQ ${i + 1}`}>
            <div className="space-y-3">
              <Field label="Question"><Input value={f.question} onChange={(e) => set(i, { question: e.target.value })} placeholder="Do you have parking?" /></Field>
              <Field label="Answer"><Textarea value={f.answer} onChange={(e) => set(i, { answer: e.target.value })} className="min-h-20" placeholder="Yes, secure on-site parking is $25 per night." /></Field>
            </div>
          </Row>
        ))}
      </ul>
      <Button type="button" variant="outline" onClick={() => onChange([...value, { question: "", answer: "" }])}><Plus /> Add FAQ</Button>
    </div>
  );
}

export function ContactsEditor({ value, onChange }: { value: Knowledge["escalationContacts"]; onChange: (v: Knowledge["escalationContacts"]) => void }) {
  const set = (i: number, patch: Partial<Knowledge["escalationContacts"][number]>) => onChange(value.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-3">
      {!value.length && <Empty text="No escalation contacts yet." />}
      <ul className="space-y-3">
        {value.map((c, i) => (
          <Row key={i} onRemove={() => onChange(value.filter((_, idx) => idx !== i))} label={`Remove contact ${c.name || i + 1}`}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Name"><Input value={c.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Front Desk" /></Field>
              <Field label="Phone"><Input type="tel" value={c.phone} onChange={(e) => set(i, { phone: e.target.value })} placeholder="+1 555 010 0100" /></Field>
              <Field label="Role"><Input value={c.role} onChange={(e) => set(i, { role: e.target.value })} placeholder="Primary" /></Field>
            </div>
          </Row>
        ))}
      </ul>
      <Button type="button" variant="outline" onClick={() => onChange([...value, { name: "", phone: "", role: "" }])}><Plus /> Add contact</Button>
    </div>
  );
}
