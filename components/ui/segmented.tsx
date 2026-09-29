"use client";
import { cn } from "@/lib/utils";

export function Segmented<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-brand-50 p-1 ring-1 ring-border", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("rounded-lg px-3.5 py-1.5 text-sm font-semibold whitespace-nowrap outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400", value === o.value ? "bg-surface text-brand-800 shadow-sm" : "text-muted hover:text-foreground")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
