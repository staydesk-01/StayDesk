import { Call, CallSummary } from "../models";
import { saveCallSummaryInput } from "../validators/tools";
import { mergeIntent } from "../services/ai/intent";
import { defineTool } from "./types";

export const saveCallSummary = defineTool({
  name: "save_call_summary",
  description:
    "Save a concise factual summary of the call (2-3 sentences), the caller's primary intent and the next action. Call this once, right before the call ends.",
  schema: saveCallSummaryInput,
  async handler({ businessId, call }, input) {
    const summary = await CallSummary.findOneAndUpdate(
      { callId: call._id, businessId },
      {
        $set: {
          summary: input.summary,
          intent: input.intent,
          outcome: input.outcome ?? "resolved",
          nextAction: input.nextAction ?? "",
          keyDetails: input.keyDetails ?? [],
          generatedBy: "agent",
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    await Call.updateOne(
      { _id: call._id },
      { $set: { summaryId: summary._id, intent: mergeIntent(call.intent as never, input.intent) } },
    );
    return { saved: true };
  },
});
