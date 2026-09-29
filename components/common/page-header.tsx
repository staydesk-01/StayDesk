import * as React from "react";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: React.ReactNode; description?: string; actions?: React.ReactNode }) {
  return (
    <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="mb-2 text-[11px] font-bold tracking-[0.2em] text-muted uppercase">{eyebrow}</p>}
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-[40px] sm:leading-[1.1]">{title}</h1>
        {description && <p className="mt-2.5 max-w-2xl text-base text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

export const Dot = () => <span className="text-brand-500">.</span>;
