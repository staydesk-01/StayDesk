"use client";
import * as React from "react";
import { ClipboardCheck, Plus } from "lucide-react";
import { FollowUpCard } from "@/components/follow-ups/follow-up-card";
import { NewFollowUpDialog } from "@/components/follow-ups/new-follow-up-dialog";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { priorityLabel } from "@/lib/format";
import type { FollowUp, Priority, TeamMember } from "@/types";

type View = "active" | "completed" | "all";

export default function FollowUpsPage() {
  const { session } = useSession();
  const [view, setView] = React.useState<View>("active");
  const [priority, setPriority] = React.useState<Priority | "any">("any");
  const [mine, setMine] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const params = new URLSearchParams({ status: view, limit: "100" });
  if (priority !== "any") params.set("priority", priority);
  if (mine) params.set("mine", "true");
  const { data, error, loading, refetch } = useApi<{ followUps: FollowUp[]; counts: Record<string, number> }>(`/follow-ups?${params}`, { events: ["followup.updated", "call.updated"], refreshMs: 30_000 });
  const team = useApi<{ users: TeamMember[] }>("/team");

  const active = (data?.counts.open ?? 0) + (data?.counts.in_progress ?? 0);
  const options = [
    { value: "active" as const, label: `Active${data ? ` (${active})` : ""}` },
    { value: "completed" as const, label: "Completed" },
    { value: "all" as const, label: "All" },
  ];

  return (
    <>
      <PageHeader
        title="Follow-ups"
        description="Work that came out of your calls: callbacks to make, bookings to confirm, questions to answer."
        actions={<Button size="lg" onClick={() => setCreating(true)}><Plus /> New follow-up</Button>}
      />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Segmented label="Follow-up status" value={view} onChange={setView} options={options} />
        <Select value={priority} onValueChange={(v) => setPriority(v as Priority | "any")} className="sm:w-44" aria-label="Priority filter"
          options={[{ value: "any", label: "Any priority" }, ...(Object.keys(priorityLabel) as Priority[]).reverse().map((p) => ({ value: p, label: priorityLabel[p] }))]} />
        <label className="flex items-center gap-2.5 text-sm font-semibold text-muted sm:ml-auto">
          <Switch checked={mine} onCheckedChange={setMine} aria-label="Assigned to me" /> Assigned to me
        </label>
      </div>

      {loading && !data ? (
        <div className="space-y-4"><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
      ) : error && !data ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : !data?.followUps.length ? (
        <Card>
          <EmptyState
            icon={ClipboardCheck}
            title={view === "active" ? "You’re all caught up" : "Nothing here yet"}
            description={view === "active" ? "No open follow-ups. When StayDesk takes a message or a booking that needs confirming, it will land here." : "Try another filter."}
            action={<Button variant="outline" onClick={() => setCreating(true)}><Plus /> Create one manually</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {data.followUps.map((f) => (
            <FollowUpCard key={f._id} item={f} team={team.data?.users ?? []} meId={session.user.id} onChanged={refetch} />
          ))}
        </div>
      )}

      <NewFollowUpDialog open={creating} onOpenChange={setCreating} onCreated={refetch} />
    </>
  );
}
