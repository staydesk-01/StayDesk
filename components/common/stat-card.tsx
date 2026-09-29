import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const tones = {
  brand: "bg-brand-100 text-brand-700",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
} as const;

export function StatCard({ label, value, hint, icon: Icon, tone = "brand", loading, className }: { label: string; value: React.ReactNode; hint?: string; icon: LucideIcon; tone?: keyof typeof tones; loading?: boolean; className?: string }) {
  return (
    <Card className={cn("p-5 sm:p-6", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] text-muted">{label}</p>
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", tones[tone])}>
          <Icon className="size-[18px]" />
        </span>
      </div>
      {loading ? <Skeleton className="mt-5 h-10 w-20" /> : <p className="mt-3 text-[38px] leading-none font-extrabold tracking-tight">{value}</p>}
      {hint && <p className="mt-3 text-[13px] text-muted">{hint}</p>}
    </Card>
  );
}
