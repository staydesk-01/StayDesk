"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useApi } from "@/hooks/use-api";

interface Metric { id: string; name: string; numerator: number; denominator: number; value: number; target: number; higherIsBetter: boolean; pass: boolean }
interface Report { generatedAt: string; warning: string; conversations: number; scenarios: number; brain: string; metrics: Metric[]; claim999: { statement: string; supported: boolean } }

/** Simulated evaluation results (from `npm run eval`). Clearly labelled; never mixed with live dashboard figures. */
export function EvalSummary() {
  const { data } = useApi<{ report: Report | null }>("/evaluation");
  const r = data?.report;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Simulated evaluation</CardTitle>
        <CardDescription>{r ? `${r.conversations} scripted conversations · ${r.brain} agent · ${new Date(r.generatedAt).toLocaleDateString()}` : "Run `npm run eval` to measure the agent."}</CardDescription>
      </CardHeader>
      {r && (
        <CardContent className="space-y-2 text-sm">
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">Simulated text conversations, not production performance. Live results are on the Overview page.</p>
          <ul className="space-y-1.5">
            {r.metrics.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <span className="text-muted">{m.name}</span>
                <span className="flex items-center gap-2 font-semibold">{m.numerator}/{m.denominator}<Badge tone={m.pass ? "success" : "danger"}>{m.pass ? "pass" : "fail"}</Badge></span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{r.claim999.statement}</p>
        </CardContent>
      )}
    </Card>
  );
}
