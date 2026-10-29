import { z } from "zod";
import { ZodError } from "zod";
import { logger } from "../config/logger";
import { Business, BusinessKnowledge, Call, PhoneConfiguration } from "../models";
import { recordAction } from "../services/calls/callService";
import { AppError } from "../utils/errors";
import { checkAvailability } from "./checkAvailability";
import { createBookingOrLead } from "./createBookingOrLead";
import { createFollowUp } from "./createFollowUp";
import { createServiceRequest } from "./createServiceRequest";
import { getBusinessInfo } from "./getBusinessInfo";
import { lookupExistingCustomer } from "./lookupExistingCustomer";
import { requestHumanTransfer } from "./requestHumanTransfer";
import { saveCallSummary } from "./saveCallSummary";
import { sendConfirmation } from "./sendConfirmation";
import { sendOwnerAlert } from "./sendOwnerAlert";
import { cancelReservation, createReservation, lookupReservation, modifyReservation } from "./reservations";
import { requestPaymentApprovalTool } from "./requestPaymentApproval";
import { fail, ok, type ToolContext, type ToolDefinition, type ToolResult } from "./types";

export const TOOLS = {
  get_business_info: getBusinessInfo,
  check_availability: checkAvailability,
  create_booking_or_lead: createBookingOrLead,
  create_service_request: createServiceRequest,
  lookup_existing_customer: lookupExistingCustomer,
  request_human_transfer: requestHumanTransfer,
  create_follow_up: createFollowUp,
  send_confirmation: sendConfirmation,
  save_call_summary: saveCallSummary,
  send_owner_alert: sendOwnerAlert,
  create_reservation: createReservation,
  modify_reservation: modifyReservation,
  cancel_reservation: cancelReservation,
  lookup_reservation: lookupReservation,
  request_payment_approval: requestPaymentApprovalTool,
} as const;

export type ToolName = keyof typeof TOOLS;
export const isToolName = (n: string): n is ToolName => n in TOOLS;

const MAX_TOOL_CALLS_PER_CALL = 40;

/** Tool definitions in OpenAI function-calling format (also usable for Retell / Vapi tool configs). */
export function toolSpecsForLlm(exclude: ToolName[] = []) {
  return (Object.values(TOOLS) as ToolDefinition<any>[])
    .filter((t) => !exclude.includes(t.name as ToolName))
    .map((t) => {
      const { $schema: _s, ...parameters } = z.toJSONSchema(t.schema as z.ZodType, { io: "input" }) as Record<string, unknown>;
      return { type: "function" as const, function: { name: t.name, description: t.description, parameters } };
    });
}

/**
 * The single entry point through which the AI touches business data. Every call:
 *  1. authenticates tenant context (call must belong to `ctx.businessId`)
 *  2. checks the call/agent is allowed to act
 *  3. validates input
 *  4. runs backend logic
 *  5. returns structured JSON and writes an audit trail on the call
 */
export async function runTool(name: string, ctx: ToolContext, rawInput: unknown): Promise<ToolResult> {
  if (!isToolName(name)) return fail("unknown_tool", `Unknown tool: ${name}`);
  const def = TOOLS[name] as ToolDefinition<unknown>;

  const call = await Call.findOne({ _id: ctx.callId, businessId: ctx.businessId });
  if (!call) return fail("not_found", "Call not found for this business");

  const [business, knowledge, config] = await Promise.all([
    Business.findById(ctx.businessId),
    BusinessKnowledge.findOne({ businessId: ctx.businessId }),
    PhoneConfiguration.findOne({ businessId: ctx.businessId }),
  ]);
  if (!business) return fail("not_found", "Business not found");

  if (call.endedAt && name !== "save_call_summary") return fail("call_ended", "The call has already ended");
  if (call.provider !== "simulator" && config && !config.agentActive) return fail("agent_disabled", "The AI agent is disabled for this business");
  if (call.actions.length >= MAX_TOOL_CALLS_PER_CALL) return fail("rate_limited", "Too many tool calls for this call");

  // State saved in MongoDB turns "unset" into null; a null field means "not provided", not an invalid value.
  const cleaned = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? Object.fromEntries(Object.entries(rawInput as Record<string, unknown>).filter(([, v]) => v !== null)) : rawInput;
  const parsed = def.schema.safeParse(cleaned ?? {});
  if (!parsed.success) {
    const message = z.prettifyError(parsed.error as ZodError);
    await recordAction(call._id, name, false, `Invalid input: ${message}`);
    await Call.updateOne({ _id: call._id }, { $inc: { "metrics.toolCalls": 1, "metrics.toolFailures": 1 } });
    return fail("validation_error", message);
  }

  try {
    const data = await def.handler({ ...ctx, call, business, knowledge, config }, parsed.data);
    // Handlers may return a ToolResult directly (e.g. fail("limit_reached")).
    const result: ToolResult = data && typeof data === "object" && "ok" in data && typeof (data as ToolResult).ok === "boolean" ? (data as ToolResult) : ok(data);
    const incomplete = result.ok && typeof result.data === "object" && result.data !== null && ((result.data as { done?: boolean }).done === false || (result.data as { confirmed?: boolean }).confirmed === false);
    await recordAction(call._id, name, result.ok && !incomplete, result.ok ? (incomplete ? `Not completed: ${summarize(name, parsed.data)}` : summarize(name, parsed.data)) : result.error.message, !!incomplete);
    await Call.updateOne({ _id: call._id }, { $inc: { "metrics.toolCalls": 1, "metrics.toolFailures": result.ok ? 0 : 1, "metrics.incompleteActions": incomplete ? 1 : 0 } });
    return result;
  } catch (e) {
    if (e instanceof AppError) {
      await recordAction(call._id, name, false, e.message);
      await Call.updateOne({ _id: call._id }, { $inc: { "metrics.toolCalls": 1, "metrics.toolFailures": 1 } });
      return fail(e.code ?? "error", e.message);
    }
    logger.error(`Tool ${name} crashed`, { message: (e as Error).message, stack: (e as Error).stack });
    await recordAction(call._id, name, false, "Internal error");
    await Call.updateOne({ _id: call._id }, { $inc: { "metrics.toolCalls": 1, "metrics.toolFailures": 1 } });
    return fail("internal_error", "The tool failed unexpectedly");
  }
}

function summarize(name: string, input: unknown): string {
  const i = input as Record<string, unknown>;
  switch (name) {
    case "create_booking_or_lead":
      return `${i.type}: ${i.customerName} – ${i.details}`;
    case "create_service_request":
      return `${i.category}${i.location ? ` @ ${i.location}` : ""}: ${i.description}`;
    case "create_follow_up":
      return `${i.priority} follow-up: ${i.reason}`;
    case "request_human_transfer":
      return `Transfer requested: ${i.reason}`;
    case "send_owner_alert":
      return `Alert (${i.type}): ${i.title}`;
    case "send_confirmation":
      return `${i.channel} confirmation to ${i.to}`;
    case "create_reservation":
      return `${i.roomType}, ${i.checkIn} to ${i.checkOut}, ${i.guests} guest(s) for ${i.guestName}`;
    case "modify_reservation":
      return `Change ${i.confirmationCode}`;
    case "cancel_reservation":
      return `Cancel ${i.confirmationCode}`;
    case "lookup_reservation":
      return `Look up ${i.confirmationCode}`;
    case "request_payment_approval":
      return `${i.kind} approval requested${i.amount != null ? ` ($${i.amount})` : ""}: ${i.description}`;
    case "check_availability":
      return i.checkIn ? `Availability ${i.checkIn} to ${i.checkOut}` : "Availability check";
    case "get_business_info":
      return `Looked up business info (${i.topic})${i.query ? `: "${i.query}"` : ""}`;
    default:
      return name.replace(/_/g, " ");
  }
}
