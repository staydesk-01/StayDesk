import twilio from "twilio";
import { env } from "../../config/env";
import { PhoneConfiguration } from "../../models";
import type { Types } from "mongoose";

/** What the dashboard can truthfully say about the Twilio account behind the TrulyHello number. */
export interface TwilioCheck {
  status: "not_configured" | "verified" | "problem" | "unreachable";
  accountType?: string;
  accountStatus?: string;
  number?: string;
  voiceUrl?: string;
  expectedVoiceUrl: string;
  voiceUrlMatches?: boolean;
  statusCallbackSet?: boolean;
  warnings: string[];
  checkedAt: string;
}
/** Minimal slice of the Twilio client we use, so tests can supply a fake. */
export interface TwilioLike {
  api: { accounts(sid: string): { fetch(): Promise<{ type: string; status: string }> } };
  incomingPhoneNumbers: { list(o: { phoneNumber: string; limit: number }): Promise<{ voiceUrl: string | null; statusCallback: string | null; phoneNumber: string }[]> };
}
let factory: () => TwilioLike | null = () => (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? (twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) as unknown as TwilioLike) : null);
export const __setTwilioCheckClientForTest = (f: (() => TwilioLike | null) | null) => { factory = f ?? (() => (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? (twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) as unknown as TwilioLike) : null)); };

const LIMITS_WARNING = "Twilio does not expose your account's concurrent-call allowance through its API. Confirm it in the Twilio Console (or with Twilio support) and prove it with a load test before promising any number of simultaneous callers.";

export async function checkTwilio(businessId: Types.ObjectId): Promise<TwilioCheck> {
  const expected = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/twilio/incoming`;
  const base = { expectedVoiceUrl: expected, checkedAt: new Date().toISOString() };
  const client = factory();
  const config = await PhoneConfiguration.findOne({ businessId }).select("twilioNumber");
  if (!client || !env.TWILIO_ACCOUNT_SID) return { ...base, status: "not_configured", warnings: ["TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set on the server.", LIMITS_WARNING] };
  const warnings = [LIMITS_WARNING];
  try {
    const acct = await client.api.accounts(env.TWILIO_ACCOUNT_SID).fetch();
    if (acct.type?.toLowerCase() === "trial") warnings.unshift("This is a Twilio TRIAL account: callers hear a trial message and only verified numbers can be called. Upgrade before customer demos.");
    if (acct.status !== "active") warnings.unshift(`The Twilio account status is "${acct.status}".`);
    const number = config?.twilioNumber ?? undefined;
    let voiceUrl: string | undefined, matches: boolean | undefined, cb: boolean | undefined;
    if (!number) warnings.unshift("No TrulyHello Twilio number is saved for this business.");
    else {
      const [n] = await client.incomingPhoneNumbers.list({ phoneNumber: number, limit: 1 });
      if (!n) warnings.unshift(`${number} was not found on this Twilio account.`);
      else {
        voiceUrl = n.voiceUrl ?? undefined;
        matches = voiceUrl === expected;
        cb = !!n.statusCallback;
        if (!matches) warnings.unshift(`The number's voice webhook is ${voiceUrl || "not set"}, expected ${expected}. Incoming calls will not reach TrulyHello.`);
        if (!cb) warnings.unshift("The number has no status callback, so call endings may not be recorded and capacity slots would only be freed by the clean-up job.");
      }
    }
    const problem = acct.status !== "active" || matches === false || !number;
    return { ...base, status: problem ? "problem" : "verified", accountType: acct.type, accountStatus: acct.status, number, voiceUrl, voiceUrlMatches: matches, statusCallbackSet: cb, warnings };
  } catch (e) {
    return { ...base, status: "unreachable", warnings: [`Twilio could not be reached or rejected the credentials (${(e as Error).message.slice(0, 120)}).`, LIMITS_WARNING] };
  }
}
