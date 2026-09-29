"use client";
import * as React from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export function DropdownMenuContent({ className, sideOffset = 8, ...props }: React.ComponentProps<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        sideOffset={sideOffset}
        className={cn("z-50 min-w-48 rounded-xl border border-border bg-surface p-1.5 shadow-[0_12px_32px_rgb(29_22_51/0.14)]", className)}
        {...props}
      />
    </DropdownPrimitive.Portal>
  );
}
export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownPrimitive.Item>) {
  return <DropdownPrimitive.Item className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-brand-50", className)} {...props} />;
}
export const DropdownMenuLabel = ({ className, ...props }: React.ComponentProps<typeof DropdownPrimitive.Label>) => (
  <DropdownPrimitive.Label className={cn("px-3 py-2 text-xs text-muted", className)} {...props} />
);
export const DropdownMenuSeparator = () => <DropdownPrimitive.Separator className="my-1 h-px bg-border" />;
