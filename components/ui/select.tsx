"use client";
import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Option {
  value: string;
  label: string;
}

/** Simple wrapper: <Select value onValueChange options />. Built on Radix for full keyboard / a11y support. */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
  "aria-label": ariaLabel,
}: {
  value?: string;
  onValueChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-border-strong bg-surface px-3.5 text-sm text-foreground outline-none transition focus:border-brand-400 focus:ring-4 focus:ring-brand-100 disabled:opacity-60 data-[placeholder]:text-subtle",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-subtle" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={6} className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-[0_12px_32px_rgb(29_22_51/0.14)]">
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value} className="relative flex cursor-pointer select-none items-center rounded-lg py-2 pr-8 pl-3 text-sm outline-none data-[highlighted]:bg-brand-50 data-[state=checked]:font-semibold">
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2.5">
                  <Check className="size-4 text-brand-600" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
