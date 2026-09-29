export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, string[]>,
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Same-origin call to the Express API (proxied by Next via rewrites). The session travels in an httpOnly cookie.
 * Never waits forever: every request is aborted after `timeoutMs`, and network / proxy failures become readable errors.
 * `status: 0` means the API could not be reached at all (not started, crashed, or timed out).
 */
export async function api<T>(path: string, { method = "GET", body, signal, timeoutMs = DEFAULT_TIMEOUT_MS }: Options = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener("abort", () => controller.abort());

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal: controller.signal,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const timedOut = (e as Error).name === "AbortError";
    throw new ApiError(0, timedOut ? "The StayDesk API took too long to respond." : "Cannot reach the StayDesk API. Is the backend running?");
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => null); // proxy errors (e.g. backend down) return non-JSON
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !/^\/(login|signup)/.test(window.location.pathname)) {
      // The session cookie is missing, expired, or belongs to a user that no longer exists. Clear it first: otherwise
      // /login would see the stale cookie and bounce straight back here, looping forever.
      const target = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      void fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" })
        .catch(() => undefined)
        .finally(() => {
          // Full navigation on purpose: resets all client state for the signed-out user.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.href = target;
        });
    }
    const message = data?.error?.message ?? (res.status >= 500 ? "The StayDesk API is unavailable (is the backend or MongoDB down?)." : `Request failed (${res.status})`);
    throw new ApiError(res.status, message, data?.error?.details);
  }
  return data as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
