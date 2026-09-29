import Link from "next/link";
import { PhoneCall } from "lucide-react";
import { HandledByBadge, IntentBadge, OutcomeBadge, StatusBadge, TestBadge } from "@/components/common/badges";
import { EmptyState } from "@/components/common/states";
import { callerLabel, formatDuration, timeAgo } from "@/lib/format";
import type { DashboardMetrics } from "@/types";

export function RecentCalls({ calls }: { calls: DashboardMetrics["recentCalls"] }) {
  if (!calls.length)
    return <EmptyState icon={PhoneCall} title="No calls yet" description="Calls handled by StayDesk will show up here the moment they happen. Try a test call to see it in action." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs font-semibold tracking-wide text-muted uppercase">
            <th className="px-6 py-3">Caller</th>
            <th className="px-3 py-3">Intent</th>
            <th className="px-3 py-3">Time</th>
            <th className="px-3 py-3">Outcome</th>
            <th className="px-6 py-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c._id} className="group border-b border-border/60 transition last:border-0 hover:bg-brand-50/60">
              <td className="px-6 py-3.5">
                <Link href={`/calls/${c._id}`} className="flex flex-col font-semibold text-foreground outline-none group-hover:text-brand-700 focus-visible:underline">
                  <span className="flex items-center gap-2">
                    {callerLabel(c)}
                    {c.provider === "simulator" && !c.isDemo && <TestBadge />}
                  </span>
                  <span className="text-xs font-normal text-muted">
                    <HandledByBadge by={c.handledBy} /> · {formatDuration(c.durationSeconds)}
                  </span>
                </Link>
              </td>
              <td className="px-3 py-3.5"><IntentBadge intent={c.intent} /></td>
              <td className="px-3 py-3.5 whitespace-nowrap text-muted">{timeAgo(c.startedAt)}</td>
              <td className="px-3 py-3.5"><OutcomeBadge outcome={c.outcome} /></td>
              <td className="px-6 py-3.5"><StatusBadge status={c.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
