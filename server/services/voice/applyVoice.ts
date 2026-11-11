import { Business, Call } from "../../models";
import type { CallInstruction } from "../telephony";
import { speakText, ttsEnabled } from "./tts";
import type { VoiceGender } from "./voices";

/**
 * Adds the business's chosen voice to an instruction that speaks.
 *  - always sets the gender, so the standard (Polly) fallback voice matches the choice;
 *  - adds ElevenLabs audio when it is configured and the business selected it.
 * If ElevenLabs is slow or down, `audioUrl` is simply left off and Twilio speaks the text itself.
 */
export async function applyVoice(instruction: CallInstruction, callSid: string | undefined): Promise<CallInstruction> {
  if (!callSid || !("say" in instruction) || !instruction.say) return instruction;

  const call = await Call.findOne({ provider: "twilio", providerCallId: callSid }).select("businessId");
  if (!call) return instruction;
  const business = await Business.findById(call.businessId).select("voice");
  const gender: VoiceGender = business?.voice?.gender === "male" ? "male" : "female";
  const out = { ...instruction, voiceGender: gender } as CallInstruction & { audioUrl?: string };

  if (business?.voice?.provider !== "polly" && ttsEnabled()) {
    const audioUrl = await speakText({ businessId: call.businessId, text: instruction.say, gender, voiceId: business?.voice?.voiceId });
    if (audioUrl) out.audioUrl = audioUrl;
  }
  return out;
}
