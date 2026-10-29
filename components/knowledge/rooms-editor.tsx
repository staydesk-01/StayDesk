"use client";
import * as React from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";

interface Terms { taxRatePercent: string; depositPolicy: string; depositPercent: string }
interface Room { name: string; description: string; nightlyRate: number; capacity: number; totalUnits: number }

/** Bookable room types. The AI quotes only these rates and checks live availability against these unit counts. */
export function RoomsEditor() {
  const { canManage } = useSession();
  const { toast } = useToast();
  const { data, loading } = useApi<{ roomTypes: Room[] }>("/inventory");
  const kn = useApi<{ knowledge: { booking?: { taxRatePercent: number | null; depositPolicy: string; depositPercent: number } } }>("/knowledge");
  const [terms, setTerms] = React.useState<Terms | null>(null);
  const b = kn.data?.knowledge.booking;
  const t: Terms = terms ?? { taxRatePercent: b?.taxRatePercent == null ? "" : String(b.taxRatePercent), depositPolicy: b?.depositPolicy ?? "none", depositPercent: String(b?.depositPercent ?? 0) };
  async function saveTerms() {
    setSaving(true);
    try {
      await api("/knowledge", { method: "PATCH", body: { booking: { taxRatePercent: t.taxRatePercent.trim() === "" ? null : Number(t.taxRatePercent), depositPolicy: t.depositPolicy, depositPercent: Number(t.depositPercent) || 0 } } });
      toast("Booking terms saved");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  }
  const [rooms, setRooms] = React.useState<Room[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const list = rooms ?? data?.roomTypes ?? [];
  const edit = (i: number, patch: Partial<Room>) => setRooms(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    setSaving(true);
    try {
      const clean = list.map((r) => ({ name: r.name, description: r.description ?? "", nightlyRate: r.nightlyRate, capacity: r.capacity, totalUnits: r.totalUnits }));
      await api("/inventory", { method: "PUT", body: { roomTypes: clean } });
      toast("Rooms saved");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) return <p className="text-sm text-muted">Loading rooms…</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">The agent only offers and prices the rooms listed here, and confirms a booking only after the booking system records it. Leave this empty if you do not take reservations by phone.</p>
      {list.map((r, i) => (
        <div key={i} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1.5fr_1fr_90px_90px_auto]">
          <Input aria-label="Room name" placeholder="Room name" value={r.name} onChange={(e) => edit(i, { name: e.target.value })} />
          <Input aria-label="Description" placeholder="Description" value={r.description} onChange={(e) => edit(i, { description: e.target.value })} />
          <Input aria-label="Nightly rate" type="number" min={0} placeholder="Rate $" value={r.nightlyRate} onChange={(e) => edit(i, { nightlyRate: Number(e.target.value) })} />
          <Input aria-label="Units" type="number" min={0} placeholder="Units" value={r.totalUnits} onChange={(e) => edit(i, { totalUnits: Number(e.target.value) })} />
          <Button type="button" variant="ghost" size="icon" aria-label="Remove room" onClick={() => setRooms(list.filter((_, j) => j !== i))}><Trash2 /></Button>
        </div>
      ))}
      {canManage && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setRooms([...list, { name: "", description: "", nightlyRate: 0, capacity: 2, totalUnits: 1 }])}><Plus /> Add room type</Button>
          <Button type="button" loading={saving} onClick={save}><Save /> Save rooms</Button>
        </div>
      )}
      <div className="mt-6 space-y-3 rounded-xl border border-border p-4">
        <p className="text-sm font-semibold">Booking terms the agent may quote</p>
        <p className="text-xs text-muted">Leave the tax rate blank if you are not sure: the agent then says taxes are not verified instead of guessing. The agent never takes card details: a deposit becomes a secure payment request for your team.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tax rate (%)"><Input type="number" min={0} max={100} step="0.01" placeholder="Not verified" value={t.taxRatePercent} onChange={(e) => setTerms({ ...t, taxRatePercent: e.target.value })} disabled={!canManage} /></Field>
          <Field label="Deposit"><Select value={t.depositPolicy} onValueChange={(v) => setTerms({ ...t, depositPolicy: v })} disabled={!canManage} aria-label="Deposit policy" options={[{ value: "none", label: "No deposit" }, { value: "after_booking", label: "Book first, then request a deposit" }, { value: "to_confirm", label: "Confirm only after the deposit" }]} /></Field>
          <Field label="Deposit (% of room total)"><Input type="number" min={0} max={100} value={t.depositPercent} onChange={(e) => setTerms({ ...t, depositPercent: e.target.value })} disabled={!canManage || t.depositPolicy === "none"} /></Field>
        </div>
        {canManage && <Button type="button" variant="outline" loading={saving} onClick={saveTerms}>Save booking terms</Button>}
      </div>
    </div>
  );
}
