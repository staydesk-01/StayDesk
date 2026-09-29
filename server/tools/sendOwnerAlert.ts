import { sendOwnerAlertInput } from "../validators/tools";
import { notify } from "../services/notifications/notificationService";
import { defineTool } from "./types";

export const sendOwnerAlert = defineTool({
  name: "send_owner_alert",
  description:
    "Alert the business owner/staff about something important: an urgent issue, an unresolved request, a callback request or a high-value opportunity.",
  schema: sendOwnerAlertInput,
  async handler({ businessId, call }, input) {
    const n = await notify({
      businessId,
      type: input.type,
      title: input.title,
      body: input.message,
      callId: call._id,
      isDemo: call.isDemo,
    });
    return { sent: !!n, note: n ? undefined : "Alerts of this type are turned off in the business's notification settings." };
  },
});
