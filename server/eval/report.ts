import { agentEngine } from "../services/ai/agentEngine";
import { METRICS, OTHER_MEASUREMENTS, type MetricId } from "./metrics";
import type { Env, Outcome, Scenario } from "./scenarios";
import { mean, percentile, samplesNeededForZeroFailureClaim, wilson } from "./stats";
import { createClinic, createHotel, type TestBusiness } from "./harness";
import { todayKey } from "./scenarios";

export interface MetricResult {
  id: MetricId | "failed_transactions";
  name: string;
  numerator: number;
  denominator: number;
  value: number | null;
  ci95: [number, number] | null;
  target: number;
  higherIsBetter: boolean;
  pass: boolean | null;
  definition: { numerator: string; denominator: string; samplePass: string; production: string; note?: string };
}

export interface Report {
  generatedAt: string;
  kind: "simulated-evaluation";
  warning: string;
  brain: string;
  scenarios: number;
  conversations: number;
  families: Record<string, { total: number; passed: number }>;
  metrics: MetricResult[];
  latency: { turns: number; meanMs: number; p95Ms: number; maxMs: number; target: string; pass: boolean };
  escalation: { rate: number; conversations: number };
  notMeasured: { id: string; name: string; reason: string }[];
  failures: { id: string; family: string; metric: string; detail: string }[];
  incidents: { id: string; detail: string }[];
  claim999: { statement: string; supported: boolean; samplesNeededForZeroFailures: number; largestDenominator: number };
  limitations: string[];
  durationSeconds: number;
}

export async function runSuite(scenarios: Scenario[], opts: { onProgress?: (done: number, total: number, s: Scenario) => void } = {}): Promise<Report> {
  const started = Date.now();
  let sharedHotel: Promise<TestBusiness> | undefined;
  let sharedClinic: Promise<TestBusiness> | undefined;
  const env: Env = {
    hotel: () => (sharedHotel ??= createHotel({ name: "Shared Eval Hotel" })),
    clinic: () => (sharedClinic ??= createClinic()),
    today: todayKey(),
  };

  const outcomes: { s: Scenario; o: Outcome }[] = [];
  const failures: Report["failures"] = [];
  let done = 0;
  for (const s of scenarios) {
    try {
      const o = await s.run(env);
      outcomes.push({ s, o });
      for (const [metric, pass] of Object.entries(o.checks)) if (pass === false) failures.push({ id: s.id, family: s.family, metric, detail: o.notes.join(" ") || "check failed" });
    } catch (e) {
      // A crash is a failure of every metric the scenario would have reported: never silently skipped.
      const detail = `scenario crashed: ${(e as Error).message}`;
      failures.push({ id: s.id, family: s.family, metric: "call_completion", detail });
      outcomes.push({ s, o: { checks: { call_completion: false, invented_answers: true }, latencies: [], escalated: false, toolCalls: 0, toolFailures: 0, injectedFailures: false, incidents: [], notes: [detail] } });
    }
    opts.onProgress?.(++done, scenarios.length, s);
  }

  const results: MetricResult[] = [];
  for (const def of METRICS) {
    let num = 0;
    let den = 0;
    if (def.id === "invented_answers") {
      for (const { s, o } of outcomes) {
        if (s.family === "intent") continue; // classifier-only samples have no replies
        den++;
        if (o.incidents.length) num++;
      }
    } else if (def.id === "failed_transactions") {
      for (const { o } of outcomes) {
        if (o.injectedFailures) continue;
        den += o.toolCalls;
        num += o.toolFailures;
      }
    } else {
      for (const { o } of outcomes) {
        const v = o.checks[def.id];
        if (v === undefined) continue;
        den++;
        if (v) num++;
      }
    }
    const value = den ? num / den : null;
    const ci = den ? wilson(num, den) : null;
    const pass = value === null ? null : def.higherIsBetter ? value >= def.target : value <= def.target;
    results.push({
      id: def.id,
      name: def.name,
      numerator: num,
      denominator: den,
      value,
      ci95: ci ? [ci.low, ci.high] : null,
      target: def.target,
      higherIsBetter: def.higherIsBetter,
      pass,
      definition: { numerator: def.numerator, denominator: def.denominator, samplePass: def.samplePass, production: def.production, note: def.note },
    });
  }

  const latencies = outcomes.flatMap(({ o }) => o.latencies);
  const conversations = outcomes.filter(({ s }) => s.family !== "intent");
  const families: Report["families"] = {};
  for (const { s, o } of outcomes) {
    const f = (families[s.family] ??= { total: 0, passed: 0 });
    f.total++;
    if (Object.values(o.checks).every((v) => v !== false) && o.incidents.length === 0) f.passed++;
  }

  const largestDen = Math.max(0, ...results.filter((r) => r.higherIsBetter).map((r) => r.denominator));
  const need = samplesNeededForZeroFailureClaim(0.999);
  const anyHigh = results.filter((r) => r.higherIsBetter && r.ci95).some((r) => r.ci95![0] >= 0.999);
  const p95 = percentile(latencies, 95);

  return {
    generatedAt: new Date().toISOString(),
    kind: "simulated-evaluation",
    warning: "These numbers come from SIMULATED text conversations run in a test database. They are not production performance and must never be presented as such.",
    brain: agentEngine.brainName(),
    scenarios: scenarios.length,
    conversations: conversations.length,
    families,
    metrics: results,
    latency: { turns: latencies.length, meanMs: Math.round(mean(latencies) * 10) / 10, p95Ms: Math.round(p95 * 10) / 10, maxMs: Math.max(0, ...latencies), target: "p95 ≤ 1500 ms", pass: p95 <= 1500 },
    escalation: { rate: conversations.length ? conversations.filter(({ o }) => o.escalated).length / conversations.length : 0, conversations: conversations.length },
    notMeasured: [
      { id: "csat", name: "Customer satisfaction", reason: "No post-call rating is collected yet." },
      { id: "voice_interruptions", name: "Audio barge-in recovery", reason: "Handled by the telephony speech layer; verify on a live call." },
      { id: "speech_recognition", name: "Accent / noisy-audio recognition accuracy", reason: "Needs real recorded audio through the speech-to-text provider; this suite feeds text only." },
      { id: "end_to_end_latency", name: "End-to-end voice latency", reason: "Includes speech-to-text, text-to-speech and network time, which require live calls." },
    ],
    failures,
    incidents: outcomes.flatMap(({ s, o }) => o.incidents.map((detail) => ({ id: s.id, detail }))),
    claim999: {
      statement: anyHigh
        ? "At least one metric's 95% interval lower bound is ≥ 99.9% — still not a production accuracy claim (simulated data only)."
        : `99.9% accuracy is NOT supported. Even with zero failures, ${need} independent, representative samples per metric are needed to show (95% confidence) a failure rate below 0.1%. The largest sample here is ${largestDen}, and these are synthetic scenarios written by the developers.`,
      supported: false,
      samplesNeededForZeroFailures: need,
      largestDenominator: largestDen,
    },
    limitations: [
      "Scenarios are synthetic and written by the same team that wrote the agent, so scores are optimistic compared with real callers.",
      "The built-in rule agent was evaluated; the OpenAI brain is non-deterministic and must be evaluated separately with your own API key.",
      "Speech recognition, accents, background noise and audio interruptions are not exercised (text only).",
      "Latency is agent compute time in-process; real calls add speech and network time.",
      "Booking runs against StayDesk's built-in booking system, not a third-party PMS.",
    ],
    durationSeconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
export function toMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# StayDesk agent evaluation (simulated)\n`);
  lines.push(`> ${r.warning}\n`);
  lines.push(`Generated ${r.generatedAt} · brain: **${r.brain}** · ${r.scenarios} scenarios (${r.conversations} conversations) · ${r.durationSeconds}s\n`);
  lines.push(`| Metric | Result | 95% interval | Target | Status |\n|---|---|---|---|---|`);
  for (const m of r.metrics) {
    const val = m.higherIsBetter ? pct(m.value) : `${m.numerator} / ${m.denominator} (${pct(m.value)})`;
    lines.push(`| ${m.name} | ${m.higherIsBetter ? `${m.numerator}/${m.denominator} = ${val}` : val} | ${m.ci95 ? `${pct(m.ci95[0])} – ${pct(m.ci95[1])}` : "n/a"} | ${m.higherIsBetter ? "≥" : "≤"} ${pct(m.target)} | ${m.pass === null ? "—" : m.pass ? "PASS" : "FAIL"} |`);
  }
  lines.push(`\nLatency (agent compute, per turn): mean ${r.latency.meanMs} ms, p95 ${r.latency.p95Ms} ms over ${r.latency.turns} turns (${r.latency.target}): ${r.latency.pass ? "PASS" : "FAIL"}`);
  lines.push(`\nHuman escalation rate: ${pct(r.escalation.rate)} of ${r.escalation.conversations} conversations (informational).`);
  lines.push(`\n## 99.9% claim\n${r.claim999.statement}`);
  lines.push(`\n## Not measured\n${r.notMeasured.map((n) => `- **${n.name}**: ${n.reason}`).join("\n")}`);
  lines.push(`\n## Limitations\n${r.limitations.map((l) => `- ${l}`).join("\n")}`);
  lines.push(`\n## Definitions\n${r.metrics.map((m) => `- **${m.name}**: ${m.definition.numerator} ÷ ${m.definition.denominator}. Sample passes when: ${m.definition.samplePass}`).join("\n")}\n${OTHER_MEASUREMENTS.map((o) => `- **${o.name}**: ${o.definition} Target: ${o.target}.`).join("\n")}`);
  if (r.failures.length) lines.push(`\n## Failures (${r.failures.length})\n${r.failures.slice(0, 80).map((f) => `- \`${f.id}\` [${f.family}/${f.metric}] ${f.detail}`).join("\n")}`);
  if (r.incidents.length) lines.push(`\n## Invented-claim incidents (${r.incidents.length})\n${r.incidents.map((i) => `- \`${i.id}\` ${i.detail}`).join("\n")}`);
  return lines.join("\n") + "\n";
}
