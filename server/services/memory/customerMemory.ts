import type { Types } from "mongoose";
import { CustomerProfile } from "../../models";
import type { BusinessDoc, CustomerProfileDoc } from "../../models";
import { flags } from "../../config/flags";
import { normalizePhone } from "../../utils/phone";
import { redactSensitive } from "../safety/sensitive";

const MAX_INTERACTIONS = 10;

export const keepsFreeText = (business: Pick<BusinessDoc, "type">) => business.type !== "medical";

/** Recognition result handed to the agent. Contains NO personal details: only whether this number has called before. */
export interface MemoryContext {
  returning: boolean;
  callCount: number;
  daysSinceLastCall?: number;
  /** Intent of the most recent previous call (not its content). */
  lastIntent?: string;
}

export async function recallCaller(businessId: Types.ObjectId, callerNumber: string): Promise<CustomerProfileDoc | null> {
  const phone = normalizePhone(callerNumber);
  if (!flags.customerMemory() || !phone) return null;
  const p = await CustomerProfile.findOne({ businessId, phone });
  return p && !p.optedOut ? p : null;
}

export function memoryContext(p: CustomerProfileDoc | null, now = new Date()): MemoryContext {
  if (!p || !p.callCount) return { returning: false, callCount: 0 };
  const last = p.interactions[p.interactions.length - 1];
  return {
    returning: true,
    callCount: p.callCount,
    daysSinceLastCall: Math.floor((now.getTime() - p.lastCallAt.getTime()) / 86400_000),
    lastIntent: last?.intent ?? undefined,
  };
}

export interface InteractionInput {
  businessId: Types.ObjectId;
  business: Pick<BusinessDoc, "type">;
  callId: Types.ObjectId;
  callerNumber: string;
  callerName?: string;
  intent: string;
  outcome: string;
  request?: string;
  nextStep?: string;
  language?: string;
  isDemo?: boolean;
}

/** Called once when a call ends. Idempotent per call (the same callId is never stored twice). */
export async function recordInteraction(i: InteractionInput): Promise<void> {
  const phone = normalizePhone(i.callerNumber);
  if (!flags.customerMemory() || !phone) return;
  const existing = await CustomerProfile.findOne({ businessId: i.businessId, phone });
  if (existing?.optedOut) return;
  if (existing?.interactions.some((x) => x.callId && String(x.callId) === String(i.callId))) return;

  const free = keepsFreeText(i.business);
  const entry = {
    callId: i.callId,
    at: new Date(),
    intent: i.intent,
    outcome: i.outcome,
    request: free && i.request ? redactSensitive(i.request).slice(0, 200) : "",
    nextStep: free && i.nextStep ? redactSensitive(i.nextStep).slice(0, 200) : "",
  };
  await CustomerProfile.updateOne(
    { businessId: i.businessId, phone },
    {
      $setOnInsert: { businessId: i.businessId, phone, firstSeenAt: new Date(), isDemo: i.isDemo ?? false },
      $set: { lastCallAt: new Date(), ...(free && i.callerName ? { name: i.callerName } : {}), ...(i.language ? { lastLanguage: i.language } : {}) },
      $inc: { callCount: 1 },
      $push: { interactions: { $each: [entry], $slice: -MAX_INTERACTIONS } },
    },
    { upsert: true },
  );
}

/**
 * Erases everything remembered about one number for one business. With `optOut`, a data-free marker is kept so
 * the number is not remembered again.
 */
export async function forgetCaller(businessId: Types.ObjectId, phoneOrId: string, opts: { optOut?: boolean } = {}): Promise<boolean> {
  const byId = /^[a-f0-9]{24}$/i.test(phoneOrId);
  const filter = byId ? { businessId, _id: phoneOrId } : { businessId, phone: normalizePhone(phoneOrId) };
  const found = await CustomerProfile.findOne(filter).select("phone");
  if (!found) return false;
  if (opts.optOut) {
    await CustomerProfile.updateOne({ _id: found._id }, { $set: { optedOut: true, name: "", callCount: 0, interactions: [], lastLanguage: "" } });
  } else {
    await CustomerProfile.deleteOne({ _id: found._id });
  }
  return true;
}
