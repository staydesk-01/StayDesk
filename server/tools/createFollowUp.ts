import { Call, FollowUp } from "../models";
import { createFollowUpInput } from "../validators/tools";
import { notify } from "../services/notifications/notificationService";
import { publish } from "../services/realtime";
import { normalizePhone } from "../utils/phone";
import { defineTool } from "./types";

const PRIORITY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 } as const;

export const createFollowUp = defineTool({
  name: "create_follow_up",
  description:
    "Create a follow-up task for staff when the request cannot be completed on the call (e.g. confirm a booking, call the customer back, unanswered question). Use type 'callback' if the caller asked to be called back.",
  schema: createFollowUpInput,
  async handler({ businessId, call }, input) {
    // One caller, one callback: if this call already has an open follow-up (e.g. the automatic one raised when a
    // transfer went unanswered), enrich it instead of creating a duplicate task for staff.
    if (input.type === "callback") {
      const existing = await FollowUp.findOne({ callId: call._id, businessId, status: { $in: ["open", "in_progress"] } }).sort({ createdAt: 1 });
      if (existing) {
        if (input.customerName && !existing.customerName) existing.customerName = input.customerName;
        if (PRIORITY_RANK[input.priority] > PRIORITY_RANK[existing.priority]) existing.priority = input.priority;
        existing.notes.push({ text: `Caller asked for a callback: ${input.reason}`, authorName: "StayDesk AI", at: new Date() });
        await existing.save();
        const set: Record<string, unknown> = { followUpRequired: true };
        if (input.customerName && !call.callerName) set.callerName = input.customerName;
        await Call.updateOne({ _id: call._id }, { $set: set });
        publish(businessId, "followup.updated", { id: String(existing._id) });
        return { followUpId: String(existing._id), status: "open", merged: true, note: "Tell the caller someone will get back to them." };
      }
    }

    // Idempotency: an identical open follow-up for this call is returned instead of creating a second task.
    const same = await FollowUp.findOne({ callId: call._id, businessId, reason: input.reason, status: { $in: ["open", "in_progress"] } });
    if (same) return { followUpId: String(same._id), status: "open", duplicate: true, note: "Tell the caller someone will get back to them." };

    const followUp = await FollowUp.create({
      businessId,
      callId: call._id,
      customerName: input.customerName ?? call.callerName,
      phone: normalizePhone(input.phone) || call.callerNumber,
      reason: input.reason,
      priority: input.priority,
      dueAt: new Date(Date.now() + (input.dueInHours ?? (input.priority === "urgent" ? 1 : input.priority === "high" ? 4 : 24)) * 3600_000),
      isDemo: call.isDemo,
    });
    const set: Record<string, unknown> = { followUpRequired: true };
    if (input.customerName && !call.callerName) set.callerName = input.customerName;
    await Call.updateOne({ _id: call._id }, { $set: set });

    if (input.type === "callback") {
      await notify({
        businessId,
        type: "callback_requested",
        title: `Callback requested${input.customerName ? ` by ${input.customerName}` : ""}`,
        body: input.reason,
        callId: call._id,
        isDemo: call.isDemo,
      });
    } else if (input.priority === "urgent") {
      await notify({ businessId, type: "urgent_request", title: "Urgent follow-up needed", body: input.reason, callId: call._id, isDemo: call.isDemo });
    }
    publish(businessId, "followup.updated", { id: String(followUp._id) });
    return { followUpId: String(followUp._id), status: "open", note: "Tell the caller someone will get back to them." };
  },
});
