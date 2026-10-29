"use client";
import * as React from "react";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CHECK_INTERVAL_MS,
  CURRENT_BUILD,
  DISMISS_KEY,
  MIN_RECHECK_MS,
  fetchLatestBuild,
  getBlockers,
  shouldNotify,
  type BuildInfo,
} from "@/lib/app-update";

/** sessionStorage can throw (private mode, blocked storage); the notifier must never break the app. */
const readDismissed = () => {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
};
const writeDismissed = (id: string) => {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, id);
  } catch {
    /* ignore */
  }
};

/**
 * Tells the user when a newer deployment is live. It never reloads on its own: "Update & Restart" refreshes the page
 * (same route, same session cookie) once it is safe, and "Later" hides the notice for this session.
 */
export function UpdateNotifier() {
  const [latest, setLatest] = React.useState<BuildInfo | null>(null);
  const [blocked, setBlocked] = React.useState<null | "call" | "unsaved">(null);
  const lastCheck = React.useRef(0);
  const box = React.useRef<HTMLDivElement>(null);

  const check = React.useCallback(async () => {
    lastCheck.current = Date.now();
    const info = await fetchLatestBuild();
    if (!info) return; // a failed check never interrupts anything
    setLatest((prev) => {
      const next = shouldNotify(CURRENT_BUILD.buildId, info, readDismissed()) ? info : null;
      // Same notice again -> keep the existing object so nothing re-renders or re-animates.
      return prev && next && prev.buildId === next.buildId ? prev : next;
    });
  }, []);

  React.useEffect(() => {
    const first = setTimeout(() => void check(), 0); // initial check once the page has settled
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck.current > MIN_RECHECK_MS) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  // While visible, publish our height so toasts and sticky save bars sit above us instead of underneath.
  const visible = !!latest;
  React.useEffect(() => {
    const root = document.documentElement;
    if (!visible || !box.current) {
      root.style.removeProperty("--sd-update-offset");
      return;
    }
    const el = box.current;
    const publish = () => root.style.setProperty("--sd-update-offset", `${Math.ceil(el.offsetHeight) + 20}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--sd-update-offset");
    };
  }, [visible]);

  if (!latest) return null;

  const dismiss = () => {
    writeDismissed(latest.buildId);
    setLatest(null);
    setBlocked(null);
  };

  const update = (confirmed = false) => {
    const b = getBlockers();
    if (b.call) return setBlocked("call"); // never interrupt a call
    if (b.unsaved && !confirmed) return setBlocked("unsaved");
    window.location.reload(); // same URL + same session cookie -> the new deployment loads in place
  };

  const label = [latest.version && `v${latest.version}`, latest.buildId.slice(0, 7)].filter(Boolean).join(" · ");

  return (
    <div
      ref={box}
      role="status"
      aria-live="polite"
      className="sd-update-in fixed right-5 bottom-5 z-[90] w-[min(22rem,calc(100vw-2.5rem))] rounded-2xl border border-border bg-surface p-3.5 text-[13px] shadow-[0_12px_32px_rgb(29_22_51/0.18)]"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-brand-100 text-brand-700">
          <RefreshCw className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-tight font-bold text-foreground">StayDesk Update Available</p>
          <p className="mt-1 text-[12px] leading-snug text-muted">A new version is ready. Update now to get the latest improvements.</p>
          {label && <p className="mt-1 text-[11px] font-semibold text-subtle">{label}</p>}
        </div>
        <button onClick={dismiss} aria-label="Dismiss update notification" className="-mt-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-subtle transition hover:bg-brand-50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none">
          <X className="size-3.5" />
        </button>
      </div>

      {blocked === "call" && (
        <p role="alert" className="mt-2.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-[12px] leading-snug text-warning">
          A call is in progress. Please finish the call before restarting.
        </p>
      )}
      {blocked === "unsaved" && (
        <p role="alert" className="mt-2.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-[12px] leading-snug text-warning">
          You have unsaved changes. Updating will reload the page and discard them.
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        {blocked === "unsaved" ? (
          <>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-[12px]" onClick={() => setBlocked(null)}>
              Keep editing
            </Button>
            <Button size="sm" className="h-7 px-2.5 text-[12px]" onClick={() => update(true)}>
              Update anyway
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px]" onClick={dismiss}>
              Later
            </Button>
            <Button size="sm" className="h-7 px-2.5 text-[12px]" onClick={() => update()}>
              Update &amp; Restart
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
