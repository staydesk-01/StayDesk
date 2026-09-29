import { Call, ServiceRequest } from "../models";
import { createServiceRequestInput } from "../validators/tools";
import { notify } from "../services/notifications/notificationService";
import { normalizePhone } from "../utils/phone";
import { defineTool } from "./types";

export const createServiceRequest = defineTool({
  name: "create_service_request",
  description:
    "Create a service request (housekeeping, maintenance, support, other) for staff to handle. Include the room number or location whenever the caller provides it.",
  schema: createServiceRequestInput,
  async handler({ businessId, call }, input) {
    const req = await ServiceRequest.create({
      businessId,
      callId: call._id,
      customerName: input.customerName ?? call.callerName,
      customerPhone: normalizePhone(input.customerPhone) || call.callerNumber,
      category: input.category,
      description: input.description,
      location: input.location ?? "",
      urgency: input.urgency,
      isDemo: call.isDemo,
    });
    if (input.customerName && !call.callerName) await Call.updateOne({ _id: call._id }, { $set: { callerName: input.customerName } });
    if (input.urgency === "urgent" || input.urgency === "high") {
      await notify({
        businessId,
        type: "urgent_request",
        title: `Urgent request${input.location ? ` (${input.location})` : ""}`,
        body: input.description,
        callId: call._id,
        isDemo: call.isDemo,
      });
    }
    return { serviceRequestId: String(req._id), status: "open", note: "Tell the caller the team has been notified." };
  },
});
