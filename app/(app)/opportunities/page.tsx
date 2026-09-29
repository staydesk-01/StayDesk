"use client";
import * as React from "react";
import Link from "next/link";
import { BadgeCheck, BadgeDollarSign, Target } from "lucide-react";
import { SampleBadge } from "@/components/common/badges";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/common/states";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMoney, formatPhone } from "@/lib/format";
import type { Opportunity, OpportunityStatus } from "@/types";

const STATUS: { value: OpportunityStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "converted", label: "Converted" },
  { value: "lost", label: "Lost" },
];
const tone: Record<OpportunityStatus, BadgeTone> = { new: "brand", contacted: "info", converted: "success", lost: "neutral" };
const typeLabel = { booking: "Booking", appointment: "Appointment", sales_lead: "Sales lead", service_inquiry: "Service inquiry" } as const;

export default function OpportunitiesPage() {
  const { toast } = useToast();
  const [filter, setFilter] = React.useState<OpportunityStatus | "all">("all");
  const { data, error, loading, refetch } = useApi<{ opportunities: Opportunity[]; totals: { potentialValue: number; verifiedRevenue: number } }>(`/opportunities?status=${filter}`, { events: ["opportunity.updated", "call.updated"], refreshMs: 30_000 });
  const [verifying, setVerifying] = React.useState<Opportunity | null>(null);
  const [amount, setAmount] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function setStatus(o: Opportunity, status: OpportunityStatus) {
    if (status === "converted") {
      setVerifying(o);
      setAmount(String(o.verifiedValue ?? o.estimatedValue ?? ""));
      return;
    }
    try {
      await api(`/opportunities/${o._id}`, { method: "PATCH", body: { status } });
      await refetch();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  async function confirmConverted(withRevenue: boolean) {
    if (!verifying) return;
    setBusy(true);
    try {
      await api(`/opportunities/${verifying._id}`, { method: "PATCH", body: { status: "converted", ...(withRevenue ? { verifiedValue: Number(amount) } : {}) } });
      toast(withRevenue ? "Marked converted with verified revenue" : "Marked converted");
      setVerifying(null);
      await refetch();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Opportunities" description="Bookings, appointments, leads and service inquiries captured from calls, tracked from first contact to confirmed revenue." />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="p-6">
          <div className="flex items-center gap-3 text-sm text-muted"><span className="grid size-10 place-items-center rounded-xl bg-brand-100 text-brand-700"><BadgeDollarSign className="size-5" /></span>Potential Opportunity Value</div>
          <p className="mt-4 text-4xl font-extrabold tracking-tight">{formatMoney(data?.totals.potentialValue)}</p>
          <p className="mt-2 text-[13px] text-muted">An estimate for open opportunities (new or contacted). It is not revenue.</p>
        </Card>
        <Card className="p-6">
          <div className="flex items-center gap-3 text-sm text-muted"><span className="grid size-10 place-items-center rounded-xl bg-success-soft text-success"><BadgeCheck className="size-5" /></span>Verified Revenue</div>
          <p className="mt-4 text-4xl font-extrabold tracking-tight text-success">{formatMoney(data?.totals.verifiedRevenue)}</p>
          <p className="mt-2 text-[13px] text-muted">Only counts transactions a team member confirmed when marking an opportunity converted.</p>
        </Card>
      </div>

      <Segmented label="Opportunity status" className="mb-5" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, ...STATUS]} />

      <Card>
        {loading && !data ? <RowsSkeleton /> : error && !data ? <ErrorState message={error} onRetry={refetch} /> : !data?.opportunities.length ? (
          <EmptyState icon={Target} title="No opportunities yet" description="When the AI captures a booking, appointment or lead on a call, it appears here." action={<Button asChild><Link href="/test-agent">Try a test call</Link></Button>} />
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs font-semibold tracking-wide text-muted uppercase">
                    <th className="py-3 pr-3 pl-6">Customer</th><th className="px-3 py-3">Type</th><th className="px-3 py-3">Details</th>
                    <th className="px-3 py-3 text-right">Potential value</th><th className="px-3 py-3 text-right">Verified revenue</th><th className="py-3 pr-6 pl-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.opportunities.map((o) => (
                    <tr key={o._id} className="border-b border-border/60 align-top last:border-0">
                      <td className="py-4 pr-3 pl-6">
                        <p className="flex items-center gap-2 font-semibold">{o.customerName || "Unknown"} {o.isDemo && <SampleBadge />}</p>
                        <p className="text-xs text-muted">{formatPhone(o.customerPhone)} · {formatDate(o.createdAt)}</p>
                        {typeof o.callId === "object" && <Link href={`/calls/${o.callId._id}`} className="text-xs font-semibold text-brand-700 hover:underline">View call</Link>}
                      </td>
                      <td className="px-3 py-4"><Badge tone="brand">{typeLabel[o.type]}</Badge></td>
                      <td className="max-w-xs px-3 py-4 text-muted">{o.details}</td>
                      <td className="px-3 py-4 text-right tabular-nums">{o.estimatedValue ? formatMoney(o.estimatedValue) : <span className="text-subtle">—</span>}</td>
                      <td className="px-3 py-4 text-right font-semibold tabular-nums">{o.verifiedValue != null ? <span className="text-success">{formatMoney(o.verifiedValue)}</span> : <span className="font-normal text-subtle">Not verified</span>}</td>
                      <td className="py-3 pr-6 pl-3"><Select className="h-9 w-36" value={o.status} onValueChange={(v) => setStatus(o, v as OpportunityStatus)} options={STATUS} aria-label={`Status for ${o.customerName}`} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-border lg:hidden">
              {data.opportunities.map((o) => (
                <li key={o._id} className="space-y-3 px-5 py-4">
                  <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{o.customerName || "Unknown"}</p><p className="text-xs text-muted">{formatPhone(o.customerPhone)}</p></div><Badge tone={tone[o.status]}>{o.status}</Badge></div>
                  <p className="text-sm text-muted">{o.details}</p>
                  <p className="text-xs">{o.verifiedValue != null ? <>Verified: <b className="text-success">{formatMoney(o.verifiedValue)}</b></> : <>Potential: <b>{formatMoney(o.estimatedValue)}</b></>}</p>
                  <Select value={o.status} onValueChange={(v) => setStatus(o, v as OpportunityStatus)} options={STATUS} aria-label="Status" />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Dialog open={!!verifying} onOpenChange={(o) => !o && setVerifying(null)}>
        <DialogContent title="Mark as converted" description="Did this opportunity become a real booking or sale? Enter the confirmed amount to count it as Verified Revenue.">
          <CardContent className="p-0">
            <Field label="Confirmed amount (USD)" htmlFor="verified" hint="Only enter what you have actually confirmed, such as the reservation total or invoice.">
              <Input id="verified" type="number" min="0" step="1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </Field>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button variant="secondary" onClick={() => confirmConverted(false)} disabled={busy}>Converted, amount unknown</Button>
              <Button onClick={() => confirmConverted(true)} loading={busy} disabled={amount === "" || Number(amount) < 0}>Confirm revenue</Button>
            </div>
          </CardContent>
        </DialogContent>
      </Dialog>
    </>
  );
}
