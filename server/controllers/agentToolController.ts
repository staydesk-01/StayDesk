import type { Request, Response } from "../http";
import { runTool } from "../tools/registry";
import type { ToolName } from "../tools/registry";
import { AppError } from "../utils/errors";
import { audit } from "../services/auditService";

/**
 * REST façade over the tool registry for external voice agents (Retell / Vapi / custom).
 * Auth = shared agent secret; tenant context = the Call referenced by `callId` (see middleware/agentAuth).
 */
function toolEndpoint(tool: ToolName) {
  return async (req: Request, res: Response) => {
    if (!req.agent) throw AppError.unauthorized();
    const { callId: _a, call_id: _b, ...args } = req.body ?? {};
    const result = await runTool(tool, { businessId: req.agent.businessId, callId: req.agent.callId }, args);
    await audit(req, req.agent.businessId, `agent.tool.${tool}`, "call", req.agent.callId, { ok: result.ok }, { type: "agent" });
    res.json(result);
  };
}

export const businessInfo = toolEndpoint("get_business_info");
export const checkAvailability = toolEndpoint("check_availability");
export const createLead = toolEndpoint("create_booking_or_lead");
export const createRequest = toolEndpoint("create_service_request");
export const lookupCustomer = toolEndpoint("lookup_existing_customer");
export const createFollowUp = toolEndpoint("create_follow_up");
export const transfer = toolEndpoint("request_human_transfer");
export const sendConfirmation = toolEndpoint("send_confirmation");
export const saveSummary = toolEndpoint("save_call_summary");
export const ownerAlert = toolEndpoint("send_owner_alert");
export const createReservation = toolEndpoint("create_reservation");
export const modifyReservation = toolEndpoint("modify_reservation");
export const cancelReservation = toolEndpoint("cancel_reservation");
export const lookupReservation = toolEndpoint("lookup_reservation");
export const requestPaymentApproval = toolEndpoint("request_payment_approval");
