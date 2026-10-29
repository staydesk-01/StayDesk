/**
 * Provider-neutral description of what the phone system should do next.
 * The call-flow logic returns these; a TelephonyProvider renders them to its own markup (TwiML / TeXML / …),
 * so adding Telnyx later means implementing `render`, not touching routing logic.
 */
export type CallInstruction =
  | { kind: "say_listen"; say: string; actionUrl: string; /** BCP-47, e.g. "es-US" */ language?: string; /** comma-separated phrases that improve speech recognition (service names, room types…) */ hints?: string; /** "auto" or seconds of silence that end the caller's turn */ speechTimeout?: "auto" | number; /** seconds to wait for the caller to start speaking */ noInputSeconds?: number }
  | { kind: "say_hangup"; say?: string; language?: string }
  | { kind: "dial"; say?: string; number: string; ringSeconds: number; actionUrl: string }
  | { kind: "sip"; uri: string }
  | { kind: "empty" };

export interface TelephonyProvider {
  readonly name: "twilio" | "telnyx";
  render(instruction: CallInstruction): string;
  sendSms(args: { from: string; to: string; body: string }): Promise<"sent" | "skipped" | "failed">;
  startRecording(callSid: string, callbackUrl: string): Promise<void>;
}
