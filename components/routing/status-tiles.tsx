import { CheckCircle2, CircleDashed } from "lucide-react";
import type { PhoneStatus } from "@/types";
import { cn } from "@/lib/utils";

const tiles: { key: keyof PhoneStatus; label: string; ok: string; todo: string }[] = [
  { key: "phoneConnected", label: "Phone connected", ok: "A StayDesk number is attached", todo: "Add your Twilio number below" },
  { key: "forwardingConfigured", label: "Forwarding configured", ok: "Calls reach StayDesk", todo: "Set up carrier forwarding" },
  { key: "agentActive", label: "Agent active", ok: "Answering overflow calls", todo: "Turn the agent on and connect a number" },
  { key: "humanFallbackConfigured", label: "Human fallback configured", ok: "Transfers ring your team", todo: "Add a human transfer number" },
];

export function StatusTiles({ status }: { status: PhoneStatus }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="list" aria-label="Setup status">
      {tiles.map((t) => {
        const ok = status[t.key];
        return (
          <div key={t.key} role="listitem" className={cn("flex items-start gap-3.5 rounded-2xl border p-5 shadow-card", ok ? "border-success/25 bg-success-soft/50" : "border-border bg-surface")}>
            {ok ? <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-success" /> : <CircleDashed className="mt-0.5 size-6 shrink-0 text-subtle" />}
            <div>
              <p className="text-[15px] font-bold">{t.label}</p>
              <p className="mt-0.5 text-[13px] text-muted">{ok ? t.ok : t.todo}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
