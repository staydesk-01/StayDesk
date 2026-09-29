import { requestHumanTransferInput } from "../validators/tools";
import { completeTransfer, startTransfer } from "../services/calls/transferService";
import { defineTool } from "./types";

export const requestHumanTransfer = defineTool({
  name: "request_human_transfer",
  description:
    "Transfer the caller to a human staff member. Say a short 'please hold' message first. If the transfer is unavailable or unanswered, apologise, keep helping and offer to take a message.",
  schema: requestHumanTransferInput,
  async handler({ call }, input) {
    const start = await startTransfer(call, input.reason);
    if (start.status === "unavailable") {
      return {
        status: "unavailable",
        instruction: "No staff line is configured. Apologise, offer to take a message; a follow-up was created for staff.",
      };
    }
    // Test-agent calls have no real phone leg: resolve the outcome the tester chose.
    if (call.provider === "simulator") {
      const answered = !!(call.agentState as { simulateTransferAnswers?: boolean } | undefined)?.simulateTransferAnswers;
      await completeTransfer(call._id, { answered, failure: "no_answer" });
      return answered
        ? { status: "connected", instruction: "A staff member answered. Say you are connecting them now and stop." }
        : {
            status: "no_answer",
            instruction: "Nobody answered. Apologise, say a team member will call them back (a follow-up was created), and keep helping.",
          };
    }
    return { status: "connecting", instruction: "Tell the caller to please hold while you connect them. Say nothing else." };
  },
});
