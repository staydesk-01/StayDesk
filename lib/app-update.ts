/** Shared by the browser and the server: what build is this, and should the user be told about a newer one? */

export interface BuildInfo {
  version: string;
  buildId: string;
}

/** The build this code was shipped in (inlined at build time; identical in the browser bundle and server bundle). */
export const CURRENT_BUILD: BuildInfo = {
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
  buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? "dev",
};

export const DISMISS_KEY = "sd_update_dismissed";
export const CHECK_INTERVAL_MS = 60_000;
/** Don't re-check more often than this when the tab regains focus. */
export const MIN_RECHECK_MS = 15_000;

/** Show the notice only for a genuinely different build the user hasn't already postponed in this session. */
export function shouldNotify(loadedBuildId: string, latest: BuildInfo | null, dismissedBuildId: string | null): boolean {
  if (!latest?.buildId) return false;
  return latest.buildId !== loadedBuildId && latest.buildId !== dismissedBuildId;
}

/** Fetches the deployed build. Any failure (offline, 5xx, bad JSON, timeout) resolves to null, never throws. */
export async function fetchLatestBuild(fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<BuildInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher("/api/app-version", { cache: "no-store", signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<BuildInfo>;
    return typeof data.buildId === "string" && data.buildId ? { buildId: data.buildId, version: String(data.version ?? "") } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- "Is it safe to reload right now?" -------------------------------------------------------------
// Screens register what they are protecting while it's true: a running call, or edits that would be lost.
type GuardKind = "call" | "unsaved";
const guards = new Map<symbol, GuardKind>();

export function registerGuard(kind: GuardKind): () => void {
  const id = Symbol(kind);
  guards.set(id, kind);
  return () => {
    guards.delete(id);
  };
}

export function getBlockers(): { call: boolean; unsaved: boolean } {
  const kinds = new Set(guards.values());
  return { call: kinds.has("call"), unsaved: kinds.has("unsaved") };
}
