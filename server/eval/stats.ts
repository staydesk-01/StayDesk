/** Wilson score interval for a proportion (95% by default). Honest about small samples, unlike a raw percentage. */
export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/**
 * Smallest sample size at which a clean run (zero failures) would show, with 95% confidence, a failure rate below
 * `1 - target` (the "rule of three" generalised): n >= ln(0.05) / ln(target).
 */
export function samplesNeededForZeroFailureClaim(target: number): number {
  return Math.ceil(Math.log(0.05) / Math.log(target));
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
