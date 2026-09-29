import { PhoneConfiguration } from "../models";
import { sendConfirmationInput } from "../validators/tools";
import { sendEmail } from "../services/notifications/email";
import { getTelephony } from "../services/telephony";
import { normalizePhone } from "../utils/phone";
import { defineTool, fail } from "./types";

const MAX_PER_CALL = 2;

export const sendConfirmation = defineTool({
  name: "send_confirmation",
  description:
    "Send a short confirmation (email or SMS) to the caller after a request is recorded. Only send to a contact the caller gave you. Do not include prices or promises staff have not approved.",
  schema: sendConfirmationInput,
  async handler({ call, business }, input) {
    const sent = call.actions.filter((a) => a.tool === "send_confirmation" && a.ok).length;
    if (sent >= MAX_PER_CALL) return fail("limit_reached", `At most ${MAX_PER_CALL} confirmations can be sent per call.`);

    const body = `${business.name}: ${input.message}`;
    if (input.channel === "email") {
      const result = await sendEmail({ to: input.to, subject: `Your request with ${business.name}`, text: body });
      return { channel: "email", status: result, note: result === "skipped" ? "Email is not configured; staff will confirm manually." : undefined };
    }
    const to = normalizePhone(input.to);
    const telephony = getTelephony();
    const cfg = await PhoneConfiguration.findOne({ businessId: business._id });
    if (!cfg?.twilioNumber) return { channel: "sms", status: "skipped", note: "No StayDesk number to send from." };
    const status = await telephony.sendSms({ from: cfg.twilioNumber, to, body });
    return { channel: "sms", status };
  },
});
