"use client";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DAYS } from "@/lib/constants";
import type { DayHours, DayKey } from "@/types";

export function HoursEditor({ value, onChange }: { value: Record<DayKey, DayHours>; onChange: (v: Record<DayKey, DayHours>) => void }) {
  const set = (k: DayKey, patch: Partial<DayHours>) => onChange({ ...value, [k]: { ...value[k], ...patch } });
  const copyMonday = () => onChange(Object.fromEntries(DAYS.map(({ key }) => [key, { ...value.mon }])) as Record<DayKey, DayHours>);

  return (
    <div>
      <ul className="divide-y divide-border rounded-2xl border border-border">
        {DAYS.map(({ key, label }) => {
          const d = value[key];
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
              <span className="w-28 text-sm font-semibold">{label}</span>
              <label className="flex items-center gap-2 text-sm text-muted">
                <Switch checked={!d.closed} onCheckedChange={(open) => set(key, { closed: !open })} aria-label={`${label} open`} />
                {d.closed ? "Closed" : "Open"}
              </label>
              {!d.closed && (
                <span className="ml-auto flex items-center gap-2">
                  <Input type="time" value={d.open} onChange={(e) => set(key, { open: e.target.value })} className="h-9 w-32" aria-label={`${label} opening time`} />
                  <span className="text-sm text-muted">to</span>
                  <Input type="time" value={d.close === "24:00" ? "23:59" : d.close} onChange={(e) => set(key, { close: e.target.value })} className="h-9 w-32" aria-label={`${label} closing time`} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copyMonday}><Copy /> Copy Monday to all days</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(Object.fromEntries(DAYS.map(({ key }) => [key, { closed: false, open: "00:00", close: "24:00" }])) as Record<DayKey, DayHours>)}>Open 24/7</Button>
      </div>
    </div>
  );
}
