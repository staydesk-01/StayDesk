import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CallCompletion } from "@/types";

const label: Record<CallCompletion["status"], [string, BadgeTone]> = {
  fulfilled: ["Completed", "success"],
  answered: ["Question answered", "info"],
  needs_follow_up: ["Needs follow-up", "warning"],
  handed_to_human: ["Handed to staff", "brand"],
  abandoned: ["Caller hung up", "neutral"],
  failed: ["Call failed", "danger"],
};

/** From request to result, using what the business systems actually recorded (not what the agent said). */
export function CompletionCard({ completion }: { completion?: CallCompletion }) {
  if (!completion) return null;
  const [text, tone] = label[completion.status];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">Request to result <Badge tone={tone}>{text}</Badge></CardTitle>
        <CardDescription>What was asked, what was done, and what is still open.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="text-xs font-semibold text-muted">Original request</p>
          <p>{completion.originalRequest || "No request captured."}</p>
        </div>
        {completion.outcomes.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted">Recorded results</p>
            <ul className="list-disc pl-5">{completion.outcomes.map((o, i) => <li key={i}>{o.type.replace(/_/g, " ")}: {o.status}{o.detail ? ` (${o.detail})` : ""}</li>)}</ul>
          </div>
        )}
        {completion.failures.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-danger">Failures</p>
            <ul className="list-disc pl-5 text-danger">{completion.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </div>
        )}
        {completion.nextSteps.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted">Next steps</p>
            <ul className="list-disc pl-5">{completion.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
