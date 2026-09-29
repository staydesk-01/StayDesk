import * as React from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-brand-100 text-brand-700">
        <Icon className="size-6" />
      </span>
      <p className="text-base font-semibold text-foreground">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-danger-soft text-danger">
        <AlertTriangle className="size-6" />
      </span>
      <p className="text-base font-semibold">We couldn’t load this</p>
      <p className="mt-1.5 max-w-sm text-sm text-muted">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

export function InlineError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
      {message}
    </p>
  );
}
