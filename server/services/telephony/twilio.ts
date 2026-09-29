import twilio from "twilio";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { CallInstruction, TelephonyProvider } from "./provider";

const VOICE = { voice: "Polly.Joanna", language: "en-US" } as const;

export class TwilioProvider implements TelephonyProvider {
  readonly name: "twilio" | "telnyx" = "twilio";
  private client?: ReturnType<typeof twilio>;

  private rest() {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
    this.client ??= twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    return this.client;
  }

  render(instruction: CallInstruction): string {
    const response = new twilio.twiml.VoiceResponse();
    switch (instruction.kind) {
      case "say_listen": {
        // <Say> inside <Gather> lets callers interrupt (barge-in). actionOnEmptyResult so silence is handled by us.
        const gather = response.gather({
          input: ["speech"],
          action: instruction.actionUrl,
          method: "POST",
          speechTimeout: "auto",
          speechModel: "phone_call",
          enhanced: true,
          language: "en-US",
          actionOnEmptyResult: true,
          timeout: 6,
        });
        gather.say(VOICE, instruction.say);
        break;
      }
      case "say_hangup":
        if (instruction.say) response.say(VOICE, instruction.say);
        response.hangup();
        break;
      case "dial": {
        if (instruction.say) response.say(VOICE, instruction.say);
        const dial = response.dial({
          timeout: instruction.ringSeconds,
          action: instruction.actionUrl,
          method: "POST",
          answerOnBridge: true,
        });
        dial.number(instruction.number);
        break;
      }
      case "sip":
        response.dial().sip(instruction.uri);
        break;
      case "empty":
        break;
    }
    return response.toString();
  }

  async sendSms({ from, to, body }: { from: string; to: string; body: string }) {
    const client = this.rest();
    if (!client || env.isTest) return "skipped" as const;
    try {
      await client.messages.create({ from, to, body });
      return "sent" as const;
    } catch (e) {
      logger.error("SMS failed", { message: (e as Error).message });
      return "failed" as const;
    }
  }

  async startRecording(callSid: string, callbackUrl: string) {
    const client = this.rest();
    if (!client || env.isTest) return;
    try {
      await client.calls(callSid).recordings.create({ recordingStatusCallback: callbackUrl, recordingStatusCallbackEvent: ["completed"] });
    } catch (e) {
      logger.error("Could not start recording", { message: (e as Error).message });
    }
  }
}
