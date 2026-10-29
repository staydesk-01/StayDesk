import type { CallStatus, HandledBy, Intent, Outcome, Priority, RoutingReason, TransferStatus, BusinessType } from "@/types";

export const intentLabel: Record<Intent, string> = {
  general_question: "General question",
  business_hours: "Business hours",
  pricing_question: "Pricing question",
  booking_inquiry: "Booking inquiry",
  appointment_request: "Appointment request",
  sales_lead: "Sales lead",
  service_request: "Service request",
  existing_customer_question: "Existing customer",
  human_request: "Human request",
  complaint: "Complaint",
  urgent_request: "Urgent request",
  unknown: "Unknown",
};

export const outcomeLabel: Record<Outcome, string> = {
  in_progress: "In progress",
  resolved: "Resolved",
  opportunity_captured: "Opportunity captured",
  service_request_created: "Service request created",
  follow_up_created: "Follow-up created",
  transferred: "Transferred to staff",
  reservation_confirmed: "Reservation confirmed",
  abandoned: "Abandoned",
  failed: "Failed",
};

export const statusLabel: Record<CallStatus, string> = {
  ringing: "Ringing",
  ai_answered: "AI on the line",
  human_transferred: "Transferred",
  completed: "Completed",
  failed: "Failed",
  abandoned: "Abandoned",
};

export const handledByLabel: Record<HandledBy, string> = { ai: "StayDesk AI", human: "Staff", ai_and_human: "AI → Staff" };

export const routingLabel: Record<RoutingReason, string> = {
  direct_ai: "AI-first routing",
  busy: "Line busy",
  no_answer: "No answer",
  overflow: "Overflow (staff on other calls)",
  after_hours: "After hours",
};

export const transferLabel: Record<TransferStatus, string> = {
  none: "—",
  ringing: "Ringing staff",
  answered: "Answered",
  no_answer: "No answer",
  failed: "Failed",
};

export const priorityLabel: Record<Priority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const businessTypeLabel: Record<BusinessType, string> = {
  hotel: "Hotel / Motel",
  restaurant: "Restaurant",
  medical: "Dental / Medical Office",
  auto_repair: "Auto Repair",
  home_services: "Home Services",
  real_estate: "Real Estate",
  salon_spa: "Salon / Spa",
  retail: "Retail",
  other: "Other",
};

export function formatDuration(seconds: number | undefined | null): string {
  if (!seconds || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatPhone(p: string | undefined | null): string {
  if (!p) return "Unknown caller";
  const d = p.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return p;
}

export const formatDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
export const formatTime = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "—");
export const formatDateTime = (iso?: string) => (iso ? `${formatDate(iso)}, ${formatTime(iso)}` : "—");

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return formatDate(iso);
}

export const formatMoney = (n: number | undefined | null) =>
  (n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const callerLabel = (c: { callerName?: string; callerNumber?: string }) => c.callerName || formatPhone(c.callerNumber);
