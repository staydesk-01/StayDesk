"use client";
import * as React from "react";
import { TriangleAlert } from "lucide-react";

/** Development-only banner: shown when the API doesn't answer /api/health (backend not started or crashed). */
export function BackendStatus() {
  const [down, setDown] = React.useState(false);

  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (!stopped) setDown(!res.ok);
      } catch {
        if (!stopped) setDown(true);
      }
    };
    void check();
    const t = setInterval(check, 5001);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  if (!down) return null;
  return (
    <div role="alert" className="flex items-center gap-2.5 bg-danger px-4 py-2.5 text-sm font-semibold text-white">
      <TriangleAlert className="size-4 shrink-0" />
      The StayDesk API or database is not responding. Check that MongoDB is running (<code className="rounded bg-white/20 px-1.5">docker compose up -d</code>) and that <code className="rounded bg-white/20 px-1.5">npm run dev</code> is still running.
    </div>
  );
}
