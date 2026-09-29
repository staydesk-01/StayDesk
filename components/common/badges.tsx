import { Badge, type BadgeTone } from "@/components/ui/badge";
import { handledByLabel, intentLabel, outcomeLabel, priorityLabel, statusLabel, transferLabel } from "@/lib/format";
import type { CallStatus, HandledBy, Intent, Outcome, Priority, TransferStatus } from "@/types";

const intentTone: Record<Intent, BadgeTone> = {
  general_question: "neutral",
  business_hours: "neutral",
  pricing_question: "neutral",
  booking_inquiry: "brand",
  appointment_request: "brand",
  sales_lead: "brand",
  service_request: "info",
  existing_customer_question: "neutral",
  human_request: "warning",
  complaint: "danger",
  urgent_request: "danger",
  unknown: "neutral",
};
export const IntentBadge = ({ intent }: { intent: Intent }) => <Badge tone={intentTone[intent]}>{intentLabel[intent]}</Badge>;

const outcomeTone: Record<Outcome, BadgeTone> = {
  in_progress: "info",
  resolved: "success",
  opportunity_captured: "brand",
  service_request_created: "info",
  follow_up_created: "warning",
  transferred: "success",
  abandoned: "danger",
  failed: "danger",
};
export const OutcomeBadge = ({ outcome }: { outcome: Outcome }) => <Badge tone={outcomeTone[outcome]}>{outcomeLabel[outcome]}</Badge>;

const statusTone: Record<CallStatus, BadgeTone> = {
  ringing: "info",
  ai_answered: "brand",
  human_transferred: "success",
  completed: "success",
  failed: "danger",
  abandoned: "danger",
};
export const StatusBadge = ({ status }: { status: CallStatus }) => <Badge tone={statusTone[status]}>{statusLabel[status]}</Badge>;

const priorityTone: Record<Priority, BadgeTone> = { low: "neutral", normal: "info", high: "warning", urgent: "danger" };
export const PriorityBadge = ({ priority }: { priority: Priority }) => <Badge tone={priorityTone[priority]}>{priorityLabel[priority]}</Badge>;

export const HandledByBadge = ({ by }: { by: HandledBy }) => <Badge tone={by === "human" ? "neutral" : "brand"}>{handledByLabel[by]}</Badge>;

const transferTone: Record<TransferStatus, BadgeTone> = { none: "neutral", ringing: "info", answered: "success", no_answer: "warning", failed: "danger" };
export const TransferBadge = ({ status }: { status: TransferStatus }) =>
  status === "none" ? <span className="text-subtle">—</span> : <Badge tone={transferTone[status]}>{transferLabel[status]}</Badge>;

export const TestBadge = () => <Badge tone="warning">Test</Badge>;
export const SampleBadge = () => <Badge tone="neutral">Sample</Badge>;
