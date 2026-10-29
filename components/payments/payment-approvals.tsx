"use client";
import * as React from "react";
import { CreditCard } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";
import { formatMoney } from "@/lib/format";

interface Approval {
  _id: string; kind: "charge" | "refund" | "adjustment"; amount?: number; description: string; customerName: string; customerPhone: string;
  status: "pending" | "approved" | "rejected" | "paid" | "failed"; paymentRef?: string; createdAt: string; callId?: string;
}
const tone: Record<Approval["status"], BadgeTone> = { pending: "warning", approved: "info", rejected: "neutral", paid: "success", failed: "danger" };

/**
 * Human approval queue for payments, refunds and adjustments requested during calls.
 * The AI can only create requests; only owners/admins can decide. StayDesk never handles card numbers: "Mark paid" records
 * a reference from whichever payment system your team used.
 */
export function PaymentApprovals() {
  const { canManage } = useSession();
  const { toast } = useToast();
  const { data, refetch } = useApi<{ approvals: Approval[]; pending: number }>("/payment-approvals?status=open", { events: ["call.updated", "followup.updated"], refreshMs: 30_000 });
  const [busy, setBusy] = React.useState<string | null>(null);
  const [refs, setRefs] = React.useState<Record<string, string>>({});
  if (!data?.approvals.length) return null;

  async function decide(id: string, action: "approve" | "reject" | "mark_paid" | "mark_failed") {
    setBusy(id);
    try {
      await api(`/payment-approvals/${id}`, { method: "POST", body: { action, ...(action === "mark_paid" ? { reference: refs[id]?.trim() } : {}) } });
      toast("Updated");
      refetch();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CreditCard className="size-5" /> Payment approvals</CardTitle>
        <CardDescription>The AI never approves or takes payments. {canManage ? "Review each request below." : "An owner or admin must decide these."} Card numbers are never collected by StayDesk.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.approvals.map((a) => (
          <div key={a._id} className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone[a.status]}>{a.status}</Badge>
              <span className="text-sm font-semibold capitalize">{a.kind}</span>
              <span className="text-sm font-bold">{a.amount != null ? formatMoney(a.amount) : "Amount to be confirmed"}</span>
              <span className="ml-auto text-xs text-muted">{new Date(a.createdAt).toLocaleString()}</span>
            </div>
            <p className="mt-2 text-sm">{a.description}</p>
            <p className="mt-1 text-xs text-muted">{[a.customerName, a.customerPhone].filter(Boolean).join(" · ") || "Caller details not captured"}</p>
            {canManage && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {a.status === "pending" && (<>
                  <Button size="sm" loading={busy === a._id} onClick={() => decide(a._id, "approve")}>Approve</Button>
                  <Button size="sm" variant="danger-outline" disabled={busy === a._id} onClick={() => decide(a._id, "reject")}>Reject</Button>
                </>)}
                {a.status === "approved" && (<>
                  <Input className="h-8 w-56" placeholder="Reference from your payment system" aria-label="Payment reference" value={refs[a._id] ?? ""} onChange={(e) => setRefs((r) => ({ ...r, [a._id]: e.target.value }))} />
                  <Button size="sm" loading={busy === a._id} disabled={!refs[a._id]?.trim()} onClick={() => decide(a._id, "mark_paid")}>Mark paid</Button>
                  <Button size="sm" variant="outline" disabled={busy === a._id} onClick={() => decide(a._id, "mark_failed")}>Mark failed</Button>
                </>)}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
