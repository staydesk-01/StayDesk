import { Call } from "../../models";
import type { BusinessDoc, KnowledgeDoc, PhoneConfigDoc, RoutingReason } from "../../models";
import { isOpenAt } from "./businessHours";
import { resolveHumanNumber } from "../business/businessService";

export type RoutingDecision =
  | { route: "human"; number: string; ringSeconds: number }
  | { route: "ai"; reason: RoutingReason };

/** How many human-first calls are currently ringing or connected for this business. */
export async function countActiveHumanCalls(businessId: BusinessDoc["_id"]) {
  return Call.countDocuments({
    businessId,
    handledBy: "human",
    endedAt: null,
    startedAt: { $gt: new Date(Date.now() - 4 * 3600_000) },
  });
}

/**
 * Decides who gets a new inbound call. Order matters:
 * AI-only → existing-number forwarding (carrier already tried humans) → after-hours → human-first / overflow.
 */
export async function decideRouting(args: {
  business: BusinessDoc;
  config: PhoneConfigDoc;
  knowledge: KnowledgeDoc | null;
  now?: Date;
}): Promise<RoutingDecision> {
  const { business, config, knowledge } = args;
  const now = args.now ?? new Date();

  if (config.aiOnly) return { route: "ai", reason: "direct_ai" };

  // Carrier busy/no-answer forwarding: the human line already had its chance.
  if (config.mode === "existing_number") return { route: "ai", reason: "no_answer" };

  if (config.afterHoursToAi && knowledge && !isOpenAt(knowledge.hours as never, business.timezone, now)) {
    return { route: "ai", reason: "after_hours" };
  }

  const number = resolveHumanNumber(business, config);
  if (!config.humanFirst || !number) return { route: "ai", reason: "direct_ai" };

  if (config.overflowToAi) {
    const active = await countActiveHumanCalls(business._id);
    if (active >= config.maxConcurrentHumanCalls) return { route: "ai", reason: "overflow" };
  }

  return { route: "human", number, ringSeconds: config.ringSeconds };
}

/** After a human-first ring fails, map Twilio's DialCallStatus to a routing reason (or null = don't use AI). */
export function reasonForDialFailure(dialStatus: string, config: PhoneConfigDoc): RoutingReason | null {
  if (dialStatus === "busy") return config.busyToAi ? "busy" : null;
  return config.noAnswerToAi ? "no_answer" : null; // no-answer, failed
}
