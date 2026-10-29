export const ROLES = ["owner", "admin", "staff"] as const;
export type Role = (typeof ROLES)[number];

export const BUSINESS_TYPES = [
  "hotel",
  "restaurant",
  "medical",
  "auto_repair",
  "home_services",
  "real_estate",
  "salon_spa",
  "retail",
  "other",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const ROUTING_REASONS = ["direct_ai", "busy", "no_answer", "overflow", "after_hours"] as const;
export type RoutingReason = (typeof ROUTING_REASONS)[number];

export const CALL_STATUSES = [
  "ringing",
  "ai_answered",
  "human_transferred",
  "completed",
  "failed",
  "abandoned",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const HANDLED_BY = ["ai", "human", "ai_and_human"] as const;
export type HandledBy = (typeof HANDLED_BY)[number];

export const INTENTS = [
  "general_question",
  "business_hours",
  "pricing_question",
  "booking_inquiry",
  "appointment_request",
  "sales_lead",
  "service_request",
  "existing_customer_question",
  "human_request",
  "complaint",
  "urgent_request",
  "unknown",
] as const;
export type Intent = (typeof INTENTS)[number];

export const OUTCOMES = [
  "in_progress",
  "resolved",
  "opportunity_captured",
  "service_request_created",
  "follow_up_created",
  "transferred",
  "reservation_confirmed",
  "abandoned",
  "failed",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const TRANSFER_STATUSES = ["none", "ringing", "answered", "no_answer", "failed"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const FOLLOW_UP_STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const OPPORTUNITY_TYPES = ["booking", "appointment", "sales_lead", "service_inquiry"] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_STATUSES = ["new", "contacted", "converted", "lost"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const SERVICE_REQUEST_STATUSES = ["open", "in_progress", "resolved", "cancelled"] as const;
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  "high_value_lead",
  "booking_inquiry",
  "urgent_request",
  "transfer_failed",
  "callback_requested",
  "unresolved_request",
  "service_request",
  "payment_approval",
  "info",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const CALL_PROVIDERS = ["twilio", "telnyx", "retell", "vapi", "sip", "simulator"] as const;
export type CallProvider = (typeof CALL_PROVIDERS)[number];

export const RESERVATION_STATUSES = ["confirmed", "modified", "cancelled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const PAYMENT_KINDS = ["charge", "refund", "adjustment"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_STATUSES = ["pending", "approved", "rejected", "paid", "failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
