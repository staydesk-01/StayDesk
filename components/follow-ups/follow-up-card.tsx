"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarClock, Check, MessageSquarePlus, MessagesSquare, Phone, UserRoundPlus } from "lucide-react";
import { IntentBadge, PriorityBadge, SampleBadge } from "@/components/common/badges";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatPhone, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FollowUp, FollowUpStatus, TeamMember } from "@/types";

const STATUSES: { value: FollowUpStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];
const bar = { low: "bg-border-strong", normal: "bg-info", high: "bg-warning", urgent: "bg-danger" } as const;

export function FollowUpCard({ item, team, meId, onChanged }: { item: FollowUp; team: TeamMember[]; meId: string; onChanged: () => void }) {
  const { toast } = useToast();
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const done = item.status === "completed" || item.status === "cancelled";
  const overdue = !done && item.dueAt && new Date(item.dueAt) < new Date();
  const call = typeof item.callId === "object" && item.callId ? item.callId : undefined;
  const callId = call?._id ?? (typeof item.callId === "string" ? item.callId : undefined);

  async function patch(body: Record<string, unknown>, success?: string) {
    setBusy(true);
    try {
      await api(`/follow-ups/${item._id}`, { method: "PATCH", body });
      if (success) toast(success);
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const assigneeOptions = [{ value: "none", label: "Unassigned" }, ...team.filter((t) => t.active).map((t) => ({ value: t.id, label: t.id === meId ? `${t.name} (me)` : t.name }))];

  return (
    <article className={cn("relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-card transition sm:p-6", done && "opacity-70")}>
      <span className={cn("absolute inset-y-0 left-0 w-1.5", bar[item.priority])} aria-hidden />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold">{item.customerName || formatPhone(item.phone)}</h3>
            <PriorityBadge priority={item.priority} />
            {item.isDemo && <SampleBadge />}
            {call && <IntentBadge intent={call.intent} />}
          </div>
          {item.customerName && item.phone && <p className="mt-0.5 text-sm text-muted">{formatPhone(item.phone)}</p>}
          <p className="mt-3 text-[15px] leading-relaxed">{item.reason}</p>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>Created {timeAgo(item.createdAt)}</span>
            {item.dueAt && (
              <span className={cn("inline-flex items-center gap-1", overdue && "font-bold text-danger")}>
                <CalendarClock className="size-3.5" /> {overdue ? "Overdue · " : "Due "}{formatDateTime(item.dueAt)}
              </span>
            )}
            {item.completedAt && <span className="text-success">Completed {timeAgo(item.completedAt)}</span>}
          </p>
          {!!item.notes.length && (
            <ul className="mt-4 space-y-2 rounded-xl bg-brand-50 p-3.5">
              {item.notes.map((n, i) => (
                <li key={i} className="text-[13px]"><span className="font-bold">{n.authorName}</span> <span className="text-muted">· {timeAgo(n.at)}</span><br />{n.text}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex w-full shrink-0 flex-col gap-2.5 lg:w-60">
          <Select value={item.status} onValueChange={(v) => patch({ status: v })} options={STATUSES} disabled={busy} aria-label="Status" />
          <Select value={item.assignedTo?._id ?? "none"} onValueChange={(v) => patch({ assignedTo: v === "none" ? null : v })} options={assigneeOptions} disabled={busy} aria-label="Assigned to" />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
        {item.phone && <Button asChild size="sm" variant="secondary"><a href={`tel:${item.phone}`}><Phone /> Call customer</a></Button>}
        {callId && <Button asChild size="sm" variant="outline"><Link href={`/calls/${callId}`}><MessagesSquare /> View conversation</Link></Button>}
        {item.assignedTo?._id !== meId && !done && <Button size="sm" variant="outline" onClick={() => patch({ assignedTo: meId }, "Assigned to you")} disabled={busy}><UserRoundPlus /> Assign to me</Button>}
        <Button size="sm" variant="outline" onClick={() => setNoteOpen(true)}><MessageSquarePlus /> Add note</Button>
        {!done && <Button size="sm" onClick={() => patch({ status: "completed" }, "Marked complete")} loading={busy} className="sm:ml-auto"><Check /> Mark complete</Button>}
      </div>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent title="Add a note" description="Notes are visible to your whole team.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Left a voicemail, will try again at 3 PM" autoFocus />
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button disabled={!note.trim()} onClick={async () => { await patch({ note: note.trim() }, "Note added"); setNote(""); setNoteOpen(false); }}>Save note</Button>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}
