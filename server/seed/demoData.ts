import type { Types } from "mongoose";
import {
  Business, BusinessKnowledge, Call, CallSummary, CallTranscript, CustomerProfile, FollowUp, TelephonyConnection, SipTrunk, BusinessPhoneNumber, CallSession, OutboundCallRequest, OutboundConsent, SuppressionEntry, CallRoutingRule, AgentProviderConfig, TelephonyHealthEvent, CallRecoveryTask, Notification, Opportunity, PaymentApproval, PhoneConfiguration, Reservation, RoomType, ServiceRequest, User,
} from "../models";
import type { Intent, Outcome, RoutingReason } from "../models";
import { createBusinessWithOwner, hashPassword } from "../services/business/businessService";

export const DEMO_OWNER = { email: "owner@sunrisehotel.demo", password: "Demo1234!" };
export const DEMO_STAFF = { email: "staff@sunrisehotel.demo", password: "Demo1234!" };
export const DEMO_STAYDESK_NUMBER = process.env.TWILIO_PHONE_NUMBER || "+15550100199";
export const DEMO_HUMAN_NUMBER = "+15550100100";

const ago = (mins: number) => new Date(Date.now() - mins * 60_000);
const H = 60;
const D = 24 * 60;

type Line = ["A" | "C", string];
interface CallSeed {
  minsAgo: number;
  caller: string;
  name?: string;
  reason: RoutingReason;
  handledBy?: "ai" | "human" | "ai_and_human";
  intent: Intent;
  outcome: Outcome;
  status?: "completed" | "human_transferred" | "abandoned" | "failed";
  seconds: number;
  transfer?: "answered" | "no_answer";
  lines?: Line[];
  summary?: string;
  nextAction?: string;
}

/** Wipes and recreates the demo business. Everything created is flagged isDemo so the UI can label it as sample data. */
export async function seedDemoBusiness() {
  const existing = await User.findOne({ email: DEMO_OWNER.email });
  if (existing) await purgeBusiness(existing.businessId);
  await User.deleteOne({ email: DEMO_STAFF.email });

  const { business, user: owner } = await createBusinessWithOwner({
    businessName: "Sunrise Boutique Hotel",
    name: "Avery Morgan",
    email: DEMO_OWNER.email,
    password: DEMO_OWNER.password,
    businessType: "hotel",
  });
  const staff = await User.create({
    email: DEMO_STAFF.email, name: "Jordan Lee", role: "staff", businessId: business._id, passwordHash: await hashPassword(DEMO_STAFF.password),
  });

  Object.assign(business, {
    phone: DEMO_HUMAN_NUMBER,
    address: "218 Ocean Avenue, Santa Barbara, CA 93101",
    timezone: "America/Los_Angeles",
    escalationPhone: DEMO_HUMAN_NUMBER,
    ownerEmail: DEMO_OWNER.email,
    agentName: "Sunny",
    onboardingComplete: true,
    isDemo: true,
  });
  await business.save();

  const day = { closed: false, open: "07:00", close: "22:00" };
  await BusinessKnowledge.updateOne(
    { businessId: business._id },
    {
      $set: {
        description: "Sunrise Boutique Hotel is a 32-room boutique hotel one block from the beach in Santa Barbara, known for ocean-view suites, a rooftop pool and a complimentary breakfast.",
        hours: { mon: day, tue: day, wed: day, thu: day, fri: { ...day, close: "23:00" }, sat: { ...day, close: "23:00" }, sun: day },
        services: [
          { name: "Deluxe King Room", description: "Queen or king bed, courtyard view, sleeps 2", price: "From $189 per night" },
          { name: "Ocean View Suite", description: "Separate lounge, private balcony, sleeps 3", price: "From $289 per night" },
          { name: "Family Room", description: "Two queen beds, sleeps 4", price: "From $229 per night" },
          { name: "Airport Shuttle", description: "Scheduled shuttle to Santa Barbara Airport, reserve 24 hours ahead", price: "$25 per person" },
          { name: "Rooftop Event Space", description: "Private events up to 40 guests", price: "From $1,200" },
        ],
        faqs: [
          { question: "What time is check-in and check-out?", answer: "Check-in starts at 3 PM and check-out is at 11 AM. Early check-in and late check-out are subject to availability; please ask the front desk." },
          { question: "Is breakfast included?", answer: "Yes, a complimentary continental breakfast is served every morning from 7 to 10 AM in the lobby cafe." },
          { question: "Do you have parking?", answer: "We offer secure on-site parking for $25 per night. Spaces are limited and first come, first served." },
          { question: "Are pets allowed?", answer: "Dogs up to 40 pounds are welcome in Deluxe King rooms for a one-time $40 pet fee." },
          { question: "Is there a pool?", answer: "Yes, our rooftop pool is open daily from 8 AM to 9 PM for hotel guests." },
          { question: "Is there Wi-Fi?", answer: "Complimentary high-speed Wi-Fi is available throughout the hotel." },
          { question: "What is the cancellation policy?", answer: "Reservations can be cancelled free of charge up to 48 hours before check-in. After that, the first night is charged." },
        ],
        pricingInfo: "Rooms start at $189 per night for a Deluxe King, $229 for a Family Room and $289 for an Ocean View Suite. Rates vary by season and weekend; the front desk confirms final pricing when booking.",
        policies: "Check-in 3 PM, check-out 11 AM. Government ID and a credit card are required at check-in. The hotel is non-smoking. Quiet hours are 10 PM to 7 AM. Free cancellation up to 48 hours before arrival.",
        escalationContacts: [{ name: "Front Desk", phone: DEMO_HUMAN_NUMBER, role: "Primary" }],
      },
    },
  );

  await PhoneConfiguration.updateOne(
    { businessId: business._id },
    { $set: { mode: "new_twilio", twilioNumber: DEMO_STAYDESK_NUMBER, humanNumber: DEMO_HUMAN_NUMBER, humanFirst: true, ringSeconds: 20, forwardingConfigured: true, agentActive: true } },
  );

  // Bookable inventory: lets the AI check live availability and book end to end for the demo hotel.
  const rooms = await RoomType.insertMany([
    { businessId: business._id, name: "Deluxe King Room", description: "King bed, courtyard view", nightlyRate: 189, capacity: 2, totalUnits: 10 },
    { businessId: business._id, name: "Family Room", description: "Two queen beds", nightlyRate: 229, capacity: 4, totalUnits: 4 },
    { businessId: business._id, name: "Ocean View Suite", description: "Separate lounge, private balcony", nightlyRate: 289, capacity: 3, totalUnits: 3 },
  ]);
  const ymd = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await Reservation.create({
    businessId: business._id, confirmationCode: "SD-DM4X92", guestName: "Taylor Brooks", guestPhone: "+18055550166",
    roomTypeId: rooms[0]._id, roomTypeName: rooms[0].name, checkIn: ymd(14), checkOut: ymd(16), nights: 2, guests: 2,
    nightlyRate: 189, totalAmount: 378, source: "staff", isDemo: true,
    history: [{ at: new Date(), action: "created", detail: "Sample reservation for testing change/cancel by phone" }],
  });

  const calls: CallSeed[] = [
    // ---- the five headline scenarios ----------------------------------------
    {
      minsAgo: 26, caller: "+18055550142", name: "Maria Lopez", reason: "no_answer", intent: "booking_inquiry", outcome: "opportunity_captured", seconds: 158,
      lines: [
        ["A", "Our team can't get to the phone right now, so I'm Sunny, the virtual assistant for Sunrise Boutique Hotel. How can I help you today?"],
        ["C", "Hi, I'd like to book an ocean view suite for next weekend."],
        ["A", "I can take a booking request for our team to confirm. What dates would you like, and how many guests?"],
        ["C", "Friday to Sunday, two nights, two adults."],
        ["A", "May I have your name, please?"],
        ["C", "Maria Lopez."],
        ["A", "Thank you, Maria. I've passed your booking request to our team and they'll call you back at this number to confirm. Is there anything else I can help you with?"],
        ["C", "No, that's all. Thanks!"],
        ["A", "Thank you for calling Sunrise Boutique Hotel. Have a wonderful day. Goodbye!"],
      ],
      summary: "Maria Lopez called about an Ocean View Suite for two adults, Friday to Sunday (2 nights). The AI captured a booking inquiry (~$578) and created a follow-up for staff to confirm availability and pricing.",
      nextAction: "Call Maria back to confirm Ocean View Suite availability for the weekend.",
    },
    {
      minsAgo: 14 * H + 40, caller: "+13105550177", name: "Daniel Kim", reason: "after_hours", intent: "service_request", outcome: "service_request_created", seconds: 121,
      lines: [
        ["A", "Our team is away at the moment, so I'm Sunny, the virtual assistant for Sunrise Boutique Hotel. How can I help you today?"],
        ["C", "Hi, I'm in room 214 and the air conditioning isn't working. Could you also send up extra towels?"],
        ["A", "I'm sorry about that. I've sent both requests to our team right away. Is there anything else I can help you with?"],
        ["C", "No, thank you."],
        ["A", "Thank you for calling Sunrise Boutique Hotel. Have a wonderful day. Goodbye!"],
      ],
      summary: "Guest in room 214 reported a broken air conditioner and asked for extra towels after hours. Maintenance and housekeeping service requests were created.",
      nextAction: "Maintenance to check the A/C in room 214.",
    },
    {
      minsAgo: 3 * H + 5, caller: "+16195550119", name: "Priya Shah", reason: "overflow", handledBy: "ai_and_human", intent: "human_request", outcome: "transferred", status: "human_transferred", seconds: 214, transfer: "answered",
      lines: [
        ["A", "Our team is busy with other calls right now, so I'm Sunny, the virtual assistant for Sunrise Boutique Hotel. How can I help you today?"],
        ["C", "I have a question about a charge on my bill. Can I speak to someone at the front desk?"],
        ["A", "Of course. Please hold while I connect you to our team."],
      ],
      summary: "Priya Shah asked to speak with the front desk about a billing charge. The AI transferred the call and a staff member answered.",
      nextAction: "No action needed.",
    },
    {
      minsAgo: 9 * H + 15, caller: "+12135550163", name: "Tom Becker", reason: "no_answer", intent: "sales_lead", outcome: "opportunity_captured", seconds: 187,
      lines: [
        ["A", "Our team can't get to the phone right now, so I'm Sunny, the virtual assistant for Sunrise Boutique Hotel. How can I help you today?"],
        ["C", "We're planning a company retreat for about 12 people in October. Do you have a room block or event space?"],
        ["A", "Our rooftop event space hosts up to 40 guests, from $1,200. I can't confirm dates, but I can take your details for our team. May I have your name, please?"],
        ["C", "Tom Becker."],
        ["A", "Thank you, Tom. I've passed your inquiry to our team and they'll call you back at this number to confirm. Is there anything else I can help you with?"],
        ["C", "That's all."],
      ],
      summary: "Tom Becker is planning a 12-person company retreat in October and asked about a room block and event space. A high-value sales lead (~$2,400) was created for the sales team.",
      nextAction: "Call Tom Becker with group rates and event space availability.",
    },
    {
      minsAgo: 2 * D + 3 * H, caller: "+18055550188", name: "Elena Ruiz", reason: "busy", intent: "business_hours", outcome: "resolved", seconds: 64,
      lines: [
        ["A", "Our team is helping other customers right now, so I'm Sunny, the virtual assistant for Sunrise Boutique Hotel. How can I help you today?"],
        ["C", "What time is check-out, and is breakfast included?"],
        ["A", "Check-out is at 11 AM. A complimentary continental breakfast is served every morning from 7 to 10 AM in the lobby cafe. Is there anything else I can help you with?"],
        ["C", "No, that's all, thanks!"],
      ],
      summary: "Elena Ruiz asked about check-out time and whether breakfast is included. The AI answered both from verified information; no follow-up needed.",
      nextAction: "No action needed.",
    },
    // ---- failed transfer + follow-up ----------------------------------------
    {
      minsAgo: 1 * D + 2 * H, caller: "+14155550101", name: "Grace Nolan", reason: "overflow", intent: "human_request", outcome: "follow_up_created", seconds: 176, transfer: "no_answer",
      lines: [
        ["A", "Our team is busy with other calls right now, so I'm Sunny, the virtual assistant for Sunrise Boutique Hotel. How can I help you today?"],
        ["C", "I need to speak with a manager about a reservation I made last month."],
        ["A", "Of course. Please hold while I connect you to our team."],
        ["A", "I'm sorry, nobody on our team is available right now. I've asked them to call you back at this number. Is there anything else I can help you with?"],
        ["C", "No, just have them call me."],
      ],
      summary: "Grace Nolan asked for a manager about an existing reservation. The transfer was not answered, so the AI created a high-priority callback follow-up.",
      nextAction: "Call Grace Nolan back about her reservation.",
    },
    // ---- abandoned + staff-handled -----------------------------------------
    { minsAgo: 4 * D + 5 * H, caller: "+19255550132", reason: "no_answer", intent: "unknown", outcome: "abandoned", status: "abandoned", seconds: 6 },
    { minsAgo: 5 * H + 30, caller: "+18055550155", name: "Chris Vega", reason: "direct_ai", handledBy: "human", intent: "unknown", outcome: "resolved", seconds: 232 },
    { minsAgo: 1 * D + 6 * H, caller: "+13235550190", reason: "direct_ai", handledBy: "human", intent: "unknown", outcome: "resolved", seconds: 145 },
    // ---- filler for a realistic chart --------------------------------------
    { minsAgo: 2 * D + 20 * H, caller: "+18185550120", reason: "after_hours", intent: "pricing_question", outcome: "resolved", seconds: 71, summary: "Caller asked about room rates. The AI shared starting prices from verified pricing." },
    { minsAgo: 2 * D + 9 * H, caller: "+16265550144", name: "Hannah Cole", reason: "busy", intent: "booking_inquiry", outcome: "opportunity_captured", seconds: 143, summary: "Hannah Cole asked about a Deluxe King for 3 nights. A booking inquiry (~$567) was captured." },
    { minsAgo: 3 * D + 2 * H, caller: "+17145550181", reason: "no_answer", intent: "general_question", outcome: "resolved", seconds: 58, summary: "Caller asked whether the hotel allows dogs. The AI shared the pet policy." },
    { minsAgo: 3 * D + 14 * H, caller: "+14085550133", name: "Marcus Bell", reason: "overflow", intent: "booking_inquiry", outcome: "opportunity_captured", seconds: 166, summary: "Marcus Bell asked for a Family Room, 2 nights. A booking inquiry (~$458) was captured." },
    { minsAgo: 4 * D + 1 * H, caller: "+15105550170", reason: "after_hours", intent: "general_question", outcome: "resolved", seconds: 49, summary: "Caller asked about parking. The AI shared parking details." },
    { minsAgo: 4 * D + 11 * H, caller: "+16505550109", name: "Olivia Park", reason: "busy", intent: "service_request", outcome: "service_request_created", seconds: 98, summary: "Guest asked for late housekeeping service in room 305. A service request was created." },
    { minsAgo: 5 * D + 3 * H, caller: "+18055550160", reason: "no_answer", intent: "business_hours", outcome: "resolved", seconds: 44, summary: "Caller asked when the front desk closes. The AI shared hours." },
    { minsAgo: 5 * D + 16 * H, caller: "+12135550122", name: "Sam Patel", reason: "overflow", intent: "booking_inquiry", outcome: "opportunity_captured", seconds: 152, summary: "Sam Patel asked about an Ocean View Suite for one night. A booking inquiry (~$289) was captured." },
    { minsAgo: 6 * D + 4 * H, caller: "+13105550111", reason: "after_hours", intent: "pricing_question", outcome: "resolved", seconds: 67, summary: "Caller asked about airport shuttle pricing. The AI shared the shuttle rate." },
    { minsAgo: 6 * D + 18 * H, caller: "+18055550175", reason: "busy", intent: "general_question", outcome: "resolved", seconds: 53, summary: "Caller asked whether the rooftop pool is open. The AI shared pool hours." },
  ];

  const byPhone: Record<string, Types.ObjectId> = {};
  for (const c of calls) {
    const startedAt = ago(c.minsAgo);
    const handledBy = c.handledBy ?? "ai";
    const status = c.status ?? "completed";
    const call = await Call.create({
      businessId: business._id, provider: "simulator", providerCallId: `demo_${c.caller}_${c.minsAgo}`,
      callerNumber: c.caller, callerName: c.name ?? "", businessNumber: DEMO_STAYDESK_NUMBER, routingReason: c.reason, handledBy,
      intent: c.intent, status, outcome: c.outcome, startedAt, answeredAt: startedAt, endedAt: new Date(startedAt.getTime() + c.seconds * 1000),
      durationSeconds: c.seconds, isDemo: true,
      transferAttempted: !!c.transfer, transferStatus: c.transfer ?? "none",
      ...(c.transfer ? { transfer: { transferStartedAt: startedAt, transferNumber: DEMO_HUMAN_NUMBER, transferAnsweredAt: c.transfer === "answered" ? new Date(startedAt.getTime() + 20_000) : undefined, attempts: [{ startedAt, number: DEMO_HUMAN_NUMBER, status: c.transfer, answeredAt: c.transfer === "answered" ? new Date(startedAt.getTime() + 20_000) : undefined, reason: "Caller asked to speak with a person" }] } } : {}),
      actions: [],
    });
    byPhone[c.caller] = call._id;

    if (c.lines) {
      const t = await CallTranscript.create({
        businessId: business._id, callId: call._id,
        segments: c.lines.map(([who, text], i) => ({ role: who === "A" ? "agent" : "caller", text, at: new Date(startedAt.getTime() + i * 12_000) })),
      });
      call.transcriptId = t._id;
    }
    if (c.summary) {
      const s = await CallSummary.create({ businessId: business._id, callId: call._id, summary: c.summary, intent: c.intent, outcome: c.outcome, nextAction: c.nextAction ?? "", generatedBy: "template",
        keyDetails: c.name ? [{ label: "Caller", value: c.name }, { label: "Phone", value: c.caller }] : [{ label: "Phone", value: c.caller }] });
      call.summaryId = s._id;
    }
    await call.save();
  }

  const opp = (phone: string, o: Partial<Parameters<typeof Opportunity.create>[0]> & Record<string, unknown>) =>
    Opportunity.create({ businessId: business._id, callId: byPhone[phone], customerPhone: phone, isDemo: true, ...o });

  const bookingMaria = await opp("+18055550142", { type: "booking", customerName: "Maria Lopez", details: "Ocean View Suite, Fri–Sun (2 nights), 2 adults", estimatedValue: 578, status: "new" });
  await opp("+12135550163", { type: "sales_lead", customerName: "Tom Becker", details: "Company retreat, ~12 guests in October; room block + rooftop event space", estimatedValue: 2400, status: "contacted" });
  await opp("+16265550144", { type: "booking", customerName: "Hannah Cole", details: "Deluxe King, 3 nights", estimatedValue: 567, status: "converted", verifiedValue: 612, verifiedBy: owner._id, verifiedAt: ago(1 * D) });
  await opp("+14085550133", { type: "booking", customerName: "Marcus Bell", details: "Family Room, 2 nights", estimatedValue: 458, status: "converted", verifiedValue: 458, verifiedBy: staff._id, verifiedAt: ago(2 * D) });
  await opp("+12135550122", { type: "booking", customerName: "Sam Patel", details: "Ocean View Suite, 1 night", estimatedValue: 289, status: "lost" });
  void bookingMaria;

  await ServiceRequest.create([
    { businessId: business._id, callId: byPhone["+13105550177"], customerName: "Daniel Kim", customerPhone: "+13105550177", category: "maintenance", description: "Air conditioning not working", location: "Room 214", urgency: "high", status: "in_progress", isDemo: true },
    { businessId: business._id, callId: byPhone["+13105550177"], customerName: "Daniel Kim", customerPhone: "+13105550177", category: "housekeeping", description: "Extra towels", location: "Room 214", urgency: "normal", status: "resolved", isDemo: true },
    { businessId: business._id, callId: byPhone["+16505550109"], customerName: "Olivia Park", customerPhone: "+16505550109", category: "housekeeping", description: "Late housekeeping service", location: "Room 305", urgency: "low", status: "open", isDemo: true },
  ]);

  const fu = (phone: string, o: Record<string, unknown>) => FollowUp.create({ businessId: business._id, callId: byPhone[phone], phone, isDemo: true, ...o });
  await fu("+18055550142", { customerName: "Maria Lopez", reason: "Confirm booking inquiry: Ocean View Suite, Fri–Sun (2 nights), 2 adults", priority: "normal", dueAt: ago(-4 * H) });
  await fu("+12135550163", { customerName: "Tom Becker", reason: "Send group rates and rooftop event availability for a 12-person retreat in October", priority: "high", status: "in_progress", assignedTo: staff._id, dueAt: ago(-2 * H),
    notes: [{ text: "Left a voicemail, will try again after 2 PM.", authorId: staff._id, authorName: staff.name, at: ago(1 * H) }] });
  await fu("+14155550101", { customerName: "Grace Nolan", reason: "Caller asked to speak with a manager about an existing reservation. Nobody answered the transfer. Please call them back.", priority: "high", dueAt: ago(-1 * H) });
  await fu("+13105550177", { customerName: "Daniel Kim", reason: "Check that the A/C in room 214 was fixed", priority: "normal", status: "completed", completedAt: ago(10 * H) });
  await Call.updateMany({ businessId: business._id, _id: { $in: ["+18055550142", "+12135550163", "+14155550101"].map((p) => byPhone[p]) } }, { $set: { followUpRequired: true } });

  await Notification.create([
    { businessId: business._id, type: "booking_inquiry", title: "New booking inquiry from Maria Lopez", body: "Ocean View Suite, Fri–Sun (2 nights), 2 adults", link: `/calls/${byPhone["+18055550142"]}`, callId: byPhone["+18055550142"], channels: { inApp: true, email: "skipped" }, isDemo: true, createdAt: ago(25) },
    { businessId: business._id, type: "transfer_failed", title: "Human transfer failed", body: "Grace Nolan asked for a person and nobody answered. A follow-up was created.", link: `/calls/${byPhone["+14155550101"]}`, callId: byPhone["+14155550101"], channels: { inApp: true, email: "skipped" }, isDemo: true, createdAt: ago(1 * D + 2 * H) },
    { businessId: business._id, type: "high_value_lead", title: "High-value sales lead: ~$2400", body: "Tom Becker: company retreat for ~12 people in October", link: `/calls/${byPhone["+12135550163"]}`, callId: byPhone["+12135550163"], read: true, channels: { inApp: true, email: "skipped" }, isDemo: true, createdAt: ago(9 * H) },
  ]);

  return { business, owner, staff };
}

async function purgeBusiness(businessId: Types.ObjectId) {
  await Promise.all([
    Call.deleteMany({ businessId }), CallTranscript.deleteMany({ businessId }), Reservation.deleteMany({ businessId }), RoomType.deleteMany({ businessId }), PaymentApproval.deleteMany({ businessId }), CustomerProfile.deleteMany({ businessId }),
    TelephonyConnection.deleteMany({ businessId }), SipTrunk.deleteMany({ businessId }), BusinessPhoneNumber.deleteMany({ businessId }), CallSession.deleteMany({ businessId }), OutboundCallRequest.deleteMany({ businessId }), OutboundConsent.deleteMany({ businessId }), SuppressionEntry.deleteMany({ businessId }), CallRoutingRule.deleteMany({ businessId }), AgentProviderConfig.deleteMany({ businessId }), TelephonyHealthEvent.deleteMany({ businessId }), CallRecoveryTask.deleteMany({ businessId }), CallSummary.deleteMany({ businessId }),
    FollowUp.deleteMany({ businessId }), Opportunity.deleteMany({ businessId }), ServiceRequest.deleteMany({ businessId }),
    Notification.deleteMany({ businessId }), BusinessKnowledge.deleteMany({ businessId }), PhoneConfiguration.deleteMany({ businessId }),
    User.deleteMany({ businessId }), Business.deleteOne({ _id: businessId }),
  ]);
}
