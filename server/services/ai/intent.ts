import type { Intent } from "../../models";

export const INTENT_LABELS: Record<Intent, string> = {
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

/** When several intents appear in one call, the higher-weight (more actionable) one is the call's primary intent. */
const WEIGHT: Record<Intent, number> = {
  urgent_request: 100,
  complaint: 85,
  booking_inquiry: 80,
  appointment_request: 80,
  sales_lead: 78,
  service_request: 76,
  human_request: 60,
  existing_customer_question: 50,
  pricing_question: 30,
  business_hours: 20,
  general_question: 10,
  unknown: 0,
};

export const ACTIONABLE_INTENTS: Intent[] = [
  "booking_inquiry",
  "appointment_request",
  "sales_lead",
  "service_request",
  "existing_customer_question",
  "complaint",
  "urgent_request",
  "human_request",
];

const rules: [Intent, RegExp][] = [
  [
    "urgent_request",
    /\b(emergency|urgent|urgently|asap|right now|immediately|fire|flood(ing|ed)?|gas leak|smell gas|smoke|burst pipe|no (heat|power|water)|locked out|medical|ambulance|police|someone is (hurt|injured)|safety)\b/,
  ],
  ["human_request", /\b(speak|talk|connect|transfer|put me through)\b.*\b(person|human|someone|manager|staff|agent|representative|receptionist|front desk|operator)\b|\b(real person|human being|operator|representative)\b|\bcan i (speak|talk) (to|with)\b|\b(get|give|bring|find)\s+me\s+(a|the|your)?\s*(manager|supervisor|person|human|someone|staff)\b|\b(i\s+)?(want|need)\s+(a|an|the|to)?\s*(real\s+)?(human|person|manager|agent|representative|supervisor)\b/],
  ["complaint", /\b(complain|complaint|unhappy|terrible|awful|horrible|worst|disappointed|unacceptable|rude|refund|dirty|filthy|disgusting|not happy)\b/],
  [
    "existing_customer_question",
    /\b(status|check on|look ?up|lookup|details|confirm(ation)?)\b[^.?!]*\bmy (\w+\s+)?(reservation|booking|appointment|stay|repair|order)\b|\bmy (\w+\s+)?(reservation|booking|appointment|order)\b[^.?!]*\b(status|number)\b|\bstatus of\b|\b(booking|confirmation|order) number\b|\bi (already )?booked\b|\balready (booked|have a)\b|\bexisting (customer|guest|patient|client)\b|\bmy (invoice|account)\b/,
  ],
  [
    "service_request",
    /\b(towels?|pillows?|blankets?|housekeeping|maintenance|broken|not working|doesn'?t work|leak(ing|s)?|clogged|toilet|shower|air ?conditioning|a\/c|heater|(wifi|wi-fi|internet)\b[^.?!]*\b(not working|down|slow|broken|doesn'?t work|won'?t|can'?t|no signal|keeps)|remote|light bulb|clean(ed|ing)? (my|the) room|room service|repair|fix|noise|noisy|extra|need (some|more|extra|another))\b/,
  ],
  // "What time is check-in?" / "Is there early check-out?" are questions, not new bookings.
  ["general_question", /\b(what|when|which)\b[^.?!]*\bcheck-?\s?(in|out)\b|\bcheck-?\s?(in|out)\b[^.?!]*\b(time|times|policy|policies|how late|how early)\b/],
  ["appointment_request", /\b(appointment|reschedule|consultation|check-?up|cleaning|haircut|massage|facial|book (me )?(in|a slot)|slot|see (the )?(doctor|dentist|stylist))\b/],
  ["booking_inquiry", /\b(book(ing)?|reserv(e|ation|ations)|availab(le|ility)|vacancy|vacancies|stay(ing)?|check-?in|check-?out|room for|table for|(\d+|one|two|three|four|five|six|a)\s+nights?)\b/],
  ["sales_lead", /\b(quote|estimate|interested in|looking (to|for)|buy|purchase|sell|listing|lease|rent|show(ing)?|proposal|price for (a|an) (project|job))\b/],
  ["business_hours", /\b(hours?|open(ing)?|close|closing|closed|what time|when do you|until when|holiday hours)\b/],
  ["pricing_question", /\b(price|prices|pricing|cost|costs|how much|rate|rates|fee|fees|charge|charges|cheap(est|er)?|deposit)\b/],
  [
    "general_question",
    /\b(where|address|location|directions|parking|pet|pets|wifi|breakfast|pool|policy|policies|cancel(lation)?|amenit|do you (have|offer|allow)|is there|are there|can i|does it)\b/,
  ],
];

export function classifyIntent(text: string): Intent {
  const t = text.toLowerCase();
  for (const [intent, re] of rules) if (re.test(t)) return intent;
  return "unknown";
}

export function mergeIntent(current: Intent | undefined, next: Intent): Intent {
  const cur = current ?? "unknown";
  return WEIGHT[next] > WEIGHT[cur] ? next : cur;
}
