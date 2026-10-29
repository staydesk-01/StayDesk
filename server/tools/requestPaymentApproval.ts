import { requestPaymentApproval } from "../services/payments/paymentService";
import { containsCardData } from "../services/safety/sensitive";
import { normalizePhone } from "../utils/phone";
import { requestPaymentApprovalInput } from "../validators/tools";
import { defineTool, fail } from "./types";

export const requestPaymentApprovalTool = defineTool({
  name: "request_payment_approval",
  description:
    "Prepare a payment, refund or financial adjustment for HUMAN approval. This charges and refunds NOTHING. Tell the caller the request is pending staff approval and that you cannot confirm any payment until a human has approved it and the payment system confirms it. Never ask for or accept card numbers on the call.",
  schema: requestPaymentApprovalInput,
  async handler({ businessId, call }, input) {
    if (containsCardData(input.description)) return fail("sensitive_data", "Do not include card numbers. Describe what the payment is for instead.");
    const approval = await requestPaymentApproval({
      businessId,
      callId: call._id,
      kind: input.kind,
      amount: input.amount,
      description: input.description,
      customerName: input.customerName ?? call.callerName,
      customerPhone: normalizePhone(call.callerNumber) || call.callerNumber,
      reservationCode: input.reservationCode,
      isDemo: call.isDemo,
    });
    return {
      status: "pending",
      approvalId: String(approval._id),
      message: "Request sent to staff. NOT approved, NOT charged, NOT refunded. Tell the caller: it is pending approval and the team will follow up.",
    };
  },
});
