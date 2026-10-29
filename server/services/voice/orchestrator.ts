import type { Types } from "mongoose";
import { logger } from "../../config/logger";
import { Call } from "../../models";
import { agentEngine } from "../ai/agentEngine";
import type { TurnResult } from "../ai/agentEngine";
import { redactSensitive } from "../safety/sensitive";

/**
 * Provider-independent voice pipeline:
 *
 *   audio in → SpeechToText → ConversationEngine (StayDesk agent + approved business tools) → TextToSpeech → audio out
 *
 * StayDesk owns the middle step. Speech recognition and synthesis (and the audio/turn-taking loop around them) run in
 * the voice worker (see staydesk-voice-agent) and are replaceable behind these contracts. This module is the single
 * place the worker asks "what should the agent say next?", so every provider gets the same memory, knowledge,
 * tool verification, idempotency, redaction and timeout handling.
 */
export interface SpeechToText {
  readonly id: string;
  /** Streaming recogniser: partial results are advisory; only `final` ends a caller turn. */
  start(opts: { language: string; hints?: string[] }): AsyncIterable<{ text: string; final: boolean }>;
}
export interface TextToSpeech {
  readonly id: string;
  synthesize(text: string, opts: { language: string; voice?: string }): AsyncIterable<Uint8Array>;
}
export interface ConversationEngine {
  readonly id: string;
  turn(input: { callId: Types.ObjectId | string; messageId: string; text: string }): Promise<TurnResult>;
}

/** The existing StayDesk agent as the conversation engine. */
export const stayDeskEngine: ConversationEngine = {
  id: "staydesk-agent",
  turn: ({ callId, messageId, text }) => agentEngine.respond(callId, text, { messageId }),
};

const TURN_TIMEOUT_MS = () => Number(process.env.VOICE_TURN_TIMEOUT_MS) || 8000;
const LATE_REPLY = "Sorry, that is taking longer than I expected. One moment, please.";

export interface VoiceTurnOutput {
  reply: string;
  end: boolean;
  transfer: boolean;
  messageId: string;
  responseId?: string;
  /** True when the engine did not answer in time: the reply is a holding line. Ask again with the SAME messageId to get the real answer. */
  late: boolean;
  engineMs: number;
}

/**
 * One caller turn from the voice worker. Idempotent on messageId (a retry never repeats actions), time-boxed, and
 * measured. A slow or failing engine never leaves the caller in silence and never invents an answer.
 */
export async function runVoiceTurn(input: { callId: Types.ObjectId | string; messageId: string; text: string; engine?: ConversationEngine }): Promise<VoiceTurnOutput> {
  const engine = input.engine ?? stayDeskEngine;
  const started = Date.now();
  const text = redactSensitive(input.text.slice(0, 1000));
  let timer: NodeJS.Timeout | undefined;
  const pending = engine.turn({ callId: input.callId, messageId: input.messageId, text });
  try {
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS()); });
    const winner = await Promise.race([pending, timeout]);
    if (winner === "timeout") {
      logger.warn("Voice turn exceeded its time limit", { callId: String(input.callId), ms: TURN_TIMEOUT_MS() });
      pending.catch(() => undefined); // it finishes in the background; a retry with the same messageId returns its stored result
      await Call.updateOne({ _id: input.callId }, { $inc: { "metrics.brainErrors": 1 } }).catch(() => undefined);
      return { reply: LATE_REPLY, end: false, transfer: false, messageId: input.messageId, late: true, engineMs: Date.now() - started };
    }
    return { reply: winner.reply, end: winner.end, transfer: winner.transfer, messageId: winner.messageId, responseId: winner.responseId, late: false, engineMs: Date.now() - started };
  } catch (e) {
    logger.error("Voice turn failed", { callId: String(input.callId), message: (e as Error).message });
    return { reply: "I'm sorry, I'm having a technical problem. Please hold on.", end: false, transfer: false, messageId: input.messageId, late: true, engineMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
