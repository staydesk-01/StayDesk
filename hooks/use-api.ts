"use client";
import * as React from "react";
import { api, errorMessage } from "@/lib/api";

interface Options {
  /** Poll interval as a fallback if the WebSocket is unavailable. */
  refreshMs?: number;
  /** Marks data that changes while a call is happening: refreshed every 10 s in the background (no WebSocket in a single Next app). */
  events?: string[];
}

interface State<T> {
  path: string | null;
  data?: T;
  error?: string;
}

/** Minimal data hook: loading / error / data, silent background refetch, realtime + polling refresh. */
export function useApi<T>(path: string | null, { refreshMs, events }: Options = {}) {
  const [state, setState] = React.useState<State<T>>({ path: null });
  const seq = React.useRef(0);

  const load = React.useCallback(async () => {
    if (path === null) return;
    const mine = ++seq.current;
    try {
      const data = await api<T>(path);
      if (mine === seq.current) setState({ path, data });
    } catch (e) {
      if (mine !== seq.current) return;
      // Keep stale data for the same path so a failed background refresh doesn't blank the screen.
      setState((s) => ({ path, data: s.path === path ? s.data : undefined, error: errorMessage(e) }));
    }
  }, [path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const every = events ? Math.min(refreshMs ?? 10_000, 10_000) : refreshMs;
  React.useEffect(() => {
    if (!every) return;
    const t = setInterval(() => void load(), every);
    return () => clearInterval(t);
  }, [load, every]);

  // Data that belongs to a previous path (e.g. a changed filter) is never shown as current.
  const current = state.path === path;
  const setData = React.useCallback((data: T) => setState({ path, data }), [path]);
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: path !== null && !current,
    refetch: load,
    reload: load,
    setData,
  };
}
