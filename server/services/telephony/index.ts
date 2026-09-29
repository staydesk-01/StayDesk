import { env } from "../../config/env";
import type { TelephonyProvider } from "./provider";
import { TelnyxProvider } from "./telnyx";
import { TwilioProvider } from "./twilio";

let provider: TelephonyProvider | undefined;

export function getTelephony(): TelephonyProvider {
  provider ??= env.TELEPHONY_PROVIDER === "telnyx" ? new TelnyxProvider() : new TwilioProvider();
  return provider;
}

export type { CallInstruction, TelephonyProvider } from "./provider";
