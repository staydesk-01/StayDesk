export type Role = "owner" | "admin" | "staff";
export type BusinessType = "hotel" | "restaurant" | "medical" | "auto_repair" | "home_services" | "real_estate" | "salon_spa" | "retail" | "other";
export type RoutingReason = "direct_ai" | "busy" | "no_answer" | "overflow" | "after_hours";
export type CallStatus = "ringing" | "ai_answered" | "human_transferred" | "completed" | "failed" | "abandoned";
export type HandledBy = "ai" | "human" | "ai_and_human";
export type Intent =
  | "general_question" | "business_hours" | "pricing_question" | "booking_inquiry" | "appointment_request" | "sales_lead"
  | "service_request" | "existing_customer_question" | "human_request" | "complaint" | "urgent_request" | "unknown";
export type Outcome = "in_progress" | "resolved" | "opportunity_captured" | "service_request_created" | "follow_up_created" | "transferred" | "abandoned" | "failed";
export type TransferStatus = "none" | "ringing" | "answered" | "no_answer" | "failed";
export type Priority = "low" | "normal" | "high" | "urgent";
export type FollowUpStatus = "open" | "in_progress" | "completed" | "cancelled";
export type OpportunityType = "booking" | "appointment" | "sales_lead" | "service_inquiry";
export type OpportunityStatus = "new" | "contacted" | "converted" | "lost";
export type ServiceRequestStatus = "open" | "in_progress" | "resolved" | "cancelled";
export type NotificationType = "high_value_lead" | "booking_inquiry" | "urgent_request" | "transfer_failed" | "callback_requested" | "unresolved_request" | "service_request" | "info";

export interface SessionUser { id: string; name: string; email: string; role: Role }
export interface SessionBusiness { id: string; name: string; type: BusinessType; onboardingComplete: boolean; isDemo: boolean }
export interface Session { user: SessionUser; business: SessionBusiness }

export interface Business {
  _id: string;
  name: string;
  type: BusinessType;
  phone: string;
  address: string;
  timezone: string;
  escalationPhone: string;
  ownerEmail: string;
  agentName: string;
  onboardingComplete: boolean;
  isDemo: boolean;
  notificationPrefs: { inApp: boolean; email: boolean; sms: boolean; events: NotificationType[]; highValueThreshold: number };
  privacy: { recordingEnabled: boolean; recordingConsentMessage: string; transcriptRetentionDays: number };
}

export interface DayHours { closed: boolean; open: string; close: string }
export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export interface Knowledge {
  _id: string;
  description: string;
  hours: Record<DayKey, DayHours>;
  services: { name: string; description: string; price: string }[];
  faqs: { question: string; answer: string }[];
  pricingInfo: string;
  policies: string;
  escalationContacts: { name: string; phone: string; role: string }[];
}

export interface PhoneConfig {
  _id: string;
  mode: "new_twilio" | "existing_number";
  twilioNumber?: string;
  existingNumber: string;
  voiceProvider: "twilio_gather" | "retell" | "vapi";
  humanFirst: boolean;
  ringSeconds: number;
  noAnswerToAi: boolean;
  busyToAi: boolean;
  afterHoursToAi: boolean;
  overflowToAi: boolean;
  maxConcurrentHumanCalls: number;
  aiOnly: boolean;
  humanNumber: string;
  forwardingConfigured: boolean;
  agentActive: boolean;
}
export interface PhoneStatus { phoneConnected: boolean; forwardingConfigured: boolean; agentActive: boolean; humanFallbackConfigured: boolean }
export interface RoutingResponse {
  config: PhoneConfig;
  status: PhoneStatus;
  integrations: { twilio: boolean; openai: boolean; email: boolean; voiceProvider: string; telephonyProvider: string };
  webhooks: { incoming: string; status: string; recording: string };
}

export interface CallAction { tool: string; at: string; ok: boolean; summary: string }
export interface Call {
  _id: string;
  provider: "twilio" | "telnyx" | "retell" | "vapi" | "simulator";
  providerCallId: string;
  callerNumber: string;
  callerName: string;
  businessNumber: string;
  routingReason: RoutingReason;
  handledBy: HandledBy;
  intent: Intent;
  status: CallStatus;
  outcome: Outcome;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  durationSeconds: number;
  followUpRequired: boolean;
  transferAttempted: boolean;
  transferStatus: TransferStatus;
  transfer?: {
    transferStartedAt?: string;
    transferNumber?: string;
    transferAnsweredAt?: string;
    attempts?: { startedAt: string; number: string; status: TransferStatus; answeredAt?: string; reason?: string }[];
  };
  actions: CallAction[];
  recording?: { enabled: boolean; url?: string; durationSeconds?: number };
  isDemo: boolean;
}

export interface TranscriptSegment { role: "agent" | "caller" | "system" | "tool"; text: string; at: string }
export interface CallSummary { summary: string; intent: Intent; outcome: Outcome; nextAction: string; keyDetails: { label: string; value: string }[]; generatedBy: string }

export interface FollowUp {
  _id: string;
  callId?: string | { _id: string; intent: Intent; startedAt: string; callerNumber: string; callerName: string };
  customerName: string;
  phone: string;
  reason: string;
  priority: Priority;
  assignedTo?: { _id: string; name: string } | null;
  status: FollowUpStatus;
  notes: { text: string; authorName: string; at: string }[];
  dueAt?: string;
  completedAt?: string;
  createdAt: string;
  isDemo: boolean;
}

export interface Opportunity {
  _id: string;
  callId?: { _id: string; startedAt: string; callerNumber: string } | string;
  type: OpportunityType;
  customerName: string;
  customerPhone: string;
  details: string;
  estimatedValue: number;
  verifiedValue?: number;
  status: OpportunityStatus;
  createdAt: string;
  isDemo: boolean;
}

export interface ServiceRequest {
  _id: string;
  category: string;
  description: string;
  location: string;
  urgency: Priority;
  status: ServiceRequestStatus;
  customerName: string;
}

export interface AppNotification { _id: string; type: NotificationType; title: string; body: string; link: string; read: boolean; createdAt: string }

export interface TeamMember { id: string; name: string; email: string; role: Role; active: boolean }

export interface DashboardMetrics {
  range: "today" | "7d" | "30d";
  isDemo: boolean;
  metrics: {
    callsReceived: number;
    aiOverflowCalls: number;
    opportunitiesCaptured: number;
    needsFollowUp: number;
    averageCallSeconds: number;
    humanTransfers: number;
    callsAbandoned: number;
    answeredByStaff: number;
    potentialOpportunityValue: number;
    verifiedRevenue: number;
  };
  chart: { label: string; calls: number; aiHandled: number; abandoned: number }[];
  recentCalls: Pick<Call, "_id" | "callerName" | "callerNumber" | "intent" | "startedAt" | "outcome" | "status" | "handledBy" | "durationSeconds" | "provider" | "isDemo">[];
}
