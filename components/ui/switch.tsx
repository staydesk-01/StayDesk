"use client";
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-border-strong transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand-600",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}

/** Row with title, description and a switch: the standard settings toggle. */
export function ToggleRow({ title, description, checked, onCheckedChange, disabled }: { title: string; description?: string; checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description && <p className="mt-0.5 text-[13px] leading-snug text-muted">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={title} />
    </div>
  );
}
