"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, CheckCircle2, CircleAlert, Phone, PhoneForwarded, ShieldAlert, Sparkles, Trash2, UserRound, Wrench } from "lucide-react";
import { HandledByBadge, IntentBadge, OutcomeBadge, PriorityBadge, StatusBadge, TestBadge, TransferBadge, SampleBadge } from "@/components/common/badges";
import { CompletionCard } from "@/components/calls/completion-card";
import { ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";
import { callerLabel, formatDateTime, formatDuration, formatMoney, formatPhone, formatTime, routingLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Call, CallSummary, FollowUp, Opportunity, ServiceRequest, TranscriptSegment } from "@/types";

interface Detail {
  call: Call;
  transcript: { segments: TranscriptSegment[] } | null;
  summary: CallSummary | null;
  opportunities: Opportunity[];
  serviceRequests: ServiceRequest[];
  followUps: FollowUp[];
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</dt>
    <dd className="mt-1.5 text-sm font-semibold">{children}</dd>
  </div>
);

export default function CallDetailPage({ params }: PageProps<"/calls/[id]">) {
  const { id } = React.use(params);
  const router = useRouter();
  const { toast } = useToast();
  const { canManage } = useSession();
  const { data, error, loading, refetch } = useApi<Detail>(`/calls/${id}`, { events: ["call.updated", "followup.updated", "opportunity.updated"], refreshMs: 15_000 });
  const [confirm, setConfirm] = React.useState<"transcript" | "call" | null>(null);

  if (loading && !data) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-10 w-72" /><Skeleton className="h-28" /><Skeleton className="h-64" />
      </div>
    );
  }
  if (error && !data) return <Card><ErrorState message={error} onRetry={refetch} /></Card>;
  if (!data) return null;

  const { call, transcript, summary, opportunities, serviceRequests, followUps } = data;
  const live = call.status === "ai_answered" && !call.endedAt;

  async function remove(kind: "transcript" | "call") {
    try {
      await api(kind === "call" ? `/calls/${id}` : `/calls/${id}/transcript`, { method: "DELETE" });
      toast(kind === "call" ? "Call deleted" : "Transcript deleted");
      if (kind === "call") router.replace("/calls");
      else await refetch();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  return (
    <>
      <Link href="/calls" className="mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand-700">
        <ArrowLeft className="size-4" /> Call activity
      </Link>

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight">{callerLabel(call)}</h1>
            {live && <Badge tone="success"><span className="sd-live-dot size-1.5 rounded-full bg-success" /> Live now</Badge>}
            {call.provider === "simulator" && (call.isDemo ? <SampleBadge /> : <TestBadge />)}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <StatusBadge status={call.status} /> <HandledByBadge by={call.handledBy} /> <IntentBadge intent={call.intent} /> <OutcomeBadge outcome={call.outcome} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {call.callerNumber && (
            <Button asChild variant="secondary"><a href={`tel:${call.callerNumber}`}><Phone /> Call back</a></Button>
          )}
          {canManage && (
            <>
              <Button variant="danger-outline" onClick={() => setConfirm("transcript")} disabled={!transcript}><Trash2 /> Delete transcript</Button>
              <Button variant="danger-outline" onClick={() => setConfirm("call")}><Trash2 /> Delete call</Button>
            </>
          )}
        </div>
      </header>

      <Card className="mb-5">
        <CardContent className="pt-5 sm:pt-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            <Fact label="Caller">
              {call.callerName || "Unknown"}
              <span className="block text-xs font-normal text-muted">{formatPhone(call.callerNumber)}</span>
            </Fact>
            <Fact label="Started">
              {formatDateTime(call.startedAt)}
            </Fact>
            <Fact label="Duration"><span className="tabular-nums">{formatDuration(call.durationSeconds)}</span></Fact>
            <Fact label="Routing reason">{routingLabel[call.routingReason]}</Fact>
            <Fact label="Handled by"><HandledByBadge by={call.handledBy} /></Fact>
            <Fact label="Transfer"><TransferBadge status={call.transferStatus} /></Fact>
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Sparkles className="size-[18px] text-brand-600" /> AI summary</CardTitle>
              {summary && <CardDescription>{summary.generatedBy === "ai" ? "Written by AI from the conversation" : summary.generatedBy === "agent" ? "Saved by the voice agent" : "Generated from the call record"}</CardDescription>}
            </CardHeader>
            <CardContent>
              {summary ? (
                <div className="space-y-4">
                  <p className="text-[15px] leading-relaxed">{summary.summary}</p>
                  {summary.nextAction && (
                    <div className="rounded-xl bg-brand-50 px-4 py-3 text-sm"><span className="font-bold text-brand-800">Next action: </span>{summary.nextAction}</div>
                  )}
                  {!!summary.keyDetails.length && (
                    <dl className="grid gap-3 sm:grid-cols-2">
                      {summary.keyDetails.map((d, i) => (
                        <div key={i} className="rounded-xl border border-border px-3.5 py-2.5">
                          <dt className="text-xs font-semibold text-muted">{d.label}</dt>
                          <dd className="mt-0.5 text-sm">{d.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted">{live ? "The summary is generated when the call ends." : call.status === "abandoned" ? "The caller hung up before a conversation took place, so there’s no summary." : "No summary was saved for this call."}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Transcript</CardTitle>
              <CardDescription>Retention is controlled in Settings → Privacy.</CardDescription>
            </CardHeader>
            <CardContent>
              {!transcript?.segments.length ? (
                <p className="text-sm text-muted">No transcript is available for this call.</p>
              ) : (
                <ol className="space-y-3" aria-label="Conversation transcript">
                  {transcript.segments.map((s, i) =>
                    s.role === "system" || s.role === "tool" ? (
                      <li key={i} className="py-1 text-center text-xs font-medium text-subtle">{s.text} · {formatTime(s.at)}</li>
                    ) : (
                      <li key={i} className={cn("flex gap-3", s.role === "caller" && "flex-row-reverse")}>
                        <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-full", s.role === "agent" ? "bg-brand-100 text-brand-700" : "bg-info-soft text-info")}>
                          {s.role === "agent" ? <Bot className="size-4" /> : <UserRound className="size-4" />}
                        </span>
                        <div className={cn("max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed", s.role === "agent" ? "rounded-tl-md bg-brand-50" : "rounded-tr-md bg-info-soft/70")}>
                          <p className="mb-0.5 text-[11px] font-bold tracking-wide text-muted uppercase">{s.role === "agent" ? "StayDesk AI" : "Caller"} · {formatTime(s.at)}</p>
                          {s.text}
                        </div>
                      </li>
                    ),
                  )}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <CompletionCard completion={call.completion} />
          <Card>
            <CardHeader><CardTitle>Actions taken</CardTitle><CardDescription>Everything the agent did through StayDesk’s backend tools.</CardDescription></CardHeader>
            <CardContent>
              {!call.actions.length ? <p className="text-sm text-muted">No tools were used on this call.</p> : (
                <ol className="space-y-3">
                  {call.actions.map((a, i) => (
                    <li key={i} className="flex gap-3">
                      {a.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />}
                      <div className="min-w-0 text-sm">
                        <p className="font-semibold">{a.tool.replace(/_/g, " ")}</p>
                        <p className="text-[13px] break-words text-muted">{a.summary}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><PhoneForwarded className="size-[18px] text-brand-600" /> Transfer attempts</CardTitle></CardHeader>
            <CardContent>
              {!call.transferAttempted ? <p className="text-sm text-muted">The caller wasn’t transferred to a person.</p> : (
                <ul className="space-y-3">
                  {(call.transfer?.attempts ?? []).map((t, i) => (
                    <li key={i} className="rounded-xl border border-border p-3.5 text-sm">
                      <div className="flex items-center justify-between gap-2"><span className="font-semibold">{t.number ? formatPhone(t.number) : "No number configured"}</span><TransferBadge status={t.status} /></div>
                      <p className="mt-1 text-xs text-muted">Started {formatTime(t.startedAt)}{t.answeredAt ? ` · answered ${formatTime(t.answeredAt)}` : ""}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Follow-up</CardTitle></CardHeader>
            <CardContent>
              {!followUps.length ? <p className="text-sm text-muted">No follow-up needed.</p> : (
                <ul className="space-y-3">
                  {followUps.map((f) => (
                    <li key={f._id} className="rounded-xl border border-border p-3.5 text-sm">
                      <div className="mb-1.5 flex flex-wrap items-center gap-1.5"><PriorityBadge priority={f.priority} /><Badge tone={f.status === "completed" ? "success" : f.status === "in_progress" ? "info" : "warning"}>{f.status.replace("_", " ")}</Badge></div>
                      <p>{f.reason}</p>
                      {f.assignedTo && <p className="mt-1 text-xs text-muted">Assigned to {f.assignedTo.name}</p>}
                    </li>
                  ))}
                  <Button asChild variant="outline" size="sm" className="w-full"><Link href="/follow-ups">Open follow-ups</Link></Button>
                </ul>
              )}
            </CardContent>
          </Card>

          {!!opportunities.length && (
            <Card>
              <CardHeader><CardTitle>Lead / booking created</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {opportunities.map((o) => (
                  <div key={o._id} className="rounded-xl border border-border p-3.5 text-sm">
                    <div className="flex items-center justify-between"><span className="font-semibold capitalize">{o.type.replace("_", " ")}</span><Badge tone="brand">{o.status}</Badge></div>
                    <p className="mt-1">{o.customerName} · {o.details}</p>
                    <p className="mt-1.5 text-xs text-muted">
                      {o.verifiedValue != null ? <>Verified revenue: <span className="font-bold text-success">{formatMoney(o.verifiedValue)}</span></> : <>Potential opportunity value: <span className="font-semibold">{o.estimatedValue ? formatMoney(o.estimatedValue) : "not estimated"}</span></>}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {!!serviceRequests.length && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Wrench className="size-[18px] text-brand-600" /> Service request created</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {serviceRequests.map((s) => (
                  <div key={s._id} className="rounded-xl border border-border p-3.5 text-sm">
                    <div className="flex items-center justify-between"><span className="font-semibold capitalize">{s.category}</span><PriorityBadge priority={s.urgency} /></div>
                    <p className="mt-1">{s.description}{s.location ? ` · ${s.location}` : ""}</p>
                    <p className="mt-1 text-xs text-muted capitalize">{s.status.replace("_", " ")}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><ShieldAlert className="size-[18px] text-brand-600" /> Recording</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted">{call.recording?.url ? `A recording was saved (${formatDuration(call.recording.durationSeconds)}).` : call.recording?.enabled ? "Recording was enabled; the file isn’t available yet." : "Call recording was off for this call."}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog open={confirm === "transcript"} onOpenChange={(o) => !o && setConfirm(null)} title="Delete this transcript?" description="The transcript is permanently removed. The call record, summary and any follow-ups stay." onConfirm={() => remove("transcript")} />
      <ConfirmDialog open={confirm === "call"} onOpenChange={(o) => !o && setConfirm(null)} title="Delete this call?" description="The call, its transcript and summary are permanently removed. Follow-ups and opportunities created by the call are kept." onConfirm={() => remove("call")} />
    </>
  );
}
