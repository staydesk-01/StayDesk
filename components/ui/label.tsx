import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-[13px] font-semibold text-foreground", className)} {...props} />;
}

/** Label + control + optional hint/error, so every form field is laid out the same way. */
export function Field({ label, hint, error, children, className, htmlFor }: { label: string; hint?: string; error?: string; children: React.ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
