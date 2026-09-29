import { TwilioProvider } from "./twilio";

/**
 * Placeholder for Telnyx. Telnyx TeXML is TwiML-compatible, so `render` is inherited as-is.
 * To finish the integration: implement webhook signature validation (Ed25519), `sendSms` and `startRecording`
 * against the Telnyx REST API, and map Telnyx webhook field names in controllers/webhookController.ts.
 */
export class TelnyxProvider extends TwilioProvider {
  readonly name = "telnyx" as const;
  async sendSms() {
    return "skipped" as const;
  }
  async startRecording() {}
}
