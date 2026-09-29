/**
 * Provider-neutral description of what the phone system should do next.
 * The call-flow logic returns these; a TelephonyProvider renders them to its own markup (TwiML / TeXML / …),
 * so adding Telnyx later means implementing `render`, not touching routing logic.
 */
export type CallInstruction =
  | { kind: "say_listen"; say: string; actionUrl: string }
  | { kind: "say_hangup"; say?: string }
  | { kind: "dial"; say?: string; number: string; ringSeconds: number; actionUrl: string }
  | { kind: "sip"; uri: string }
  | { kind: "empty" };

export interface TelephonyProvider {
  readonly name: "twilio" | "telnyx";
  render(instruction: CallInstruction): string;
  sendSms(args: { from: string; to: string; body: string }): Promise<"sent" | "skipped" | "failed">;
  startRecording(callSid: string, callbackUrl: string): Promise<void>;
}
