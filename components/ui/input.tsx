import * as React from "react";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-xl border border-border-strong bg-surface px-3.5 text-sm text-foreground placeholder:text-subtle outline-none transition focus:border-brand-400 focus:ring-4 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-brand-50/50 disabled:opacity-70 aria-[invalid=true]:border-danger";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, type = "text", ...props }, ref) {
  return <input ref={ref} type={type} className={cn(field, "h-10", className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(field, "min-h-24 py-2.5 leading-relaxed", className)} {...props} />;
});
