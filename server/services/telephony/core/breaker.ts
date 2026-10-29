import { TelephonyError } from "./types";

/**
 * Circuit breaker per provider. After `threshold` consecutive failures the circuit opens and calls fail fast (so a dead
 * provider does not add its timeout to every call); after `cooldownMs` one trial call is allowed (half-open).
 * State is per process: it protects that instance's calls, and every transition is also written as a health event.
 */
export type BreakerState = "closed" | "open" | "half_open";

interface Entry {
  failures: number;
  openedAt?: number;
  trial: boolean;
}

export class CircuitBreakers {
  private entries = new Map<string, Entry>();
  constructor(
    private threshold = 3,
    private cooldownMs = 30_000,
    private now: () => number = Date.now,
    private onChange: (provider: string, state: BreakerState) => void = () => undefined,
  ) {}

  private get(p: string): Entry {
    let e = this.entries.get(p);
    if (!e) this.entries.set(p, (e = { failures: 0, trial: false }));
    return e;
  }

  state(provider: string): BreakerState {
    const e = this.get(provider);
    if (e.openedAt === undefined) return "closed";
    return this.now() - e.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  /** Throws `circuit_open` if the provider must not be called right now. */
  assertCallable(provider: string) {
    const s = this.state(provider);
    const e = this.get(provider);
    if (s === "open" || (s === "half_open" && e.trial)) throw new TelephonyError("circuit_open", `${provider} is temporarily disabled after repeated failures`);
    if (s === "half_open") e.trial = true; // exactly one trial call at a time
  }

  success(provider: string) {
    const e = this.get(provider);
    const was = this.state(provider);
    e.failures = 0;
    e.openedAt = undefined;
    e.trial = false;
    if (was !== "closed") this.onChange(provider, "closed");
  }

  failure(provider: string) {
    const e = this.get(provider);
    e.trial = false;
    e.failures += 1;
    if (e.failures >= this.threshold && (e.openedAt === undefined || this.state(provider) === "half_open")) {
      e.openedAt = this.now();
      this.onChange(provider, "open");
    }
  }

  reset() {
    this.entries.clear();
  }
}

export const breakers = new CircuitBreakers(Number(process.env.TELEPHONY_BREAKER_THRESHOLD) || 3, Number(process.env.TELEPHONY_BREAKER_COOLDOWN_MS) || 30_000);

/**
 * Runs `fn` against each provider in priority order. A provider whose circuit is open is skipped; a failure moves on to
 * the next one. Returns which provider finally served the request. Throws the last error if all fail.
 */
export async function runWithFailover<T>(
  providers: string[],
  fn: (provider: string) => Promise<T>,
  b: CircuitBreakers = breakers,
): Promise<{ provider: string; value: T; skipped: string[]; failed: { provider: string; error: string }[] }> {
  const skipped: string[] = [];
  const failed: { provider: string; error: string }[] = [];
  for (const provider of providers) {
    try {
      b.assertCallable(provider);
    } catch {
      skipped.push(provider);
      continue;
    }
    try {
      const value = await fn(provider);
      b.success(provider);
      return { provider, value, skipped, failed };
    } catch (e) {
      b.failure(provider);
      failed.push({ provider, error: (e as Error).message });
    }
  }
  throw new TelephonyError("provider_error", `No provider could handle the request (${[...skipped.map((s) => `${s}: circuit open`), ...failed.map((f) => `${f.provider}: ${f.error}`)].join("; ") || "none configured"})`);
}
