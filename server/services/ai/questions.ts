import type { KnowledgeDoc } from "../../models";
import { bestAnswer } from "./knowledgeSearch";

type Rooms = Parameters<typeof bestAnswer>[2];

const QUESTION_WORD = "what|when|where|which|who|whom|whose|why|how|is|are|do|does|did|can|could|will|would|should|have|has|any";

/** "What time is check-out and is breakfast included?" -> ["What time is check-out", "is breakfast included"]. */
export function splitQuestions(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[?.!;])\s+/)
    .map((s) => s.trim().replace(/[?.!;]+$/, ""))
    .filter(Boolean);
  const parts: string[] = [];
  const joiner = new RegExp(`(?:\\s*,\\s*(?:and|also)?\\s*|\\s+(?:and|also|plus|and also|&)\\s+)(?=(?:${QUESTION_WORD})\\b)`, "i");
  for (const s of sentences) parts.push(...s.split(joiner).map((p) => p.trim()).filter((p) => p.split(/\s+/).length >= 2));
  return parts.length ? parts : [text.trim()];
}

/** Looks like the caller is asking something (as opposed to giving a name, a date, "yes"...). */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) || new RegExp(`^(${QUESTION_WORD})\\b`, "i").test(t) || /\b(is|are) (breakfast|parking|wifi|there|it)\b/i.test(t);
}

export interface QuestionAnswers {
  answered: { question: string; answer: string }[];
  unanswered: string[];
}

/**
 * Answers every question in a message from verified knowledge only. A part without a verified answer is reported
 * as unanswered (never guessed). Identical answers (e.g. "check-in" and "check-out" share one FAQ) appear once.
 */
export function answerQuestions(text: string, knowledge: KnowledgeDoc | null, rooms: Rooms): QuestionAnswers {
  const whole = bestAnswer(text, knowledge, rooms);
  const pieces = splitQuestions(text);
  if (whole && pieces.length <= 1) return { answered: [{ question: text, answer: whole.answer }], unanswered: [] };

  const answered: QuestionAnswers["answered"] = [];
  const unanswered: string[] = [];
  for (const q of pieces) {
    const hit = bestAnswer(q, knowledge, rooms);
    if (!hit) unanswered.push(q);
    else if (!answered.some((a) => a.answer === hit.answer)) answered.push({ question: q, answer: hit.answer });
  }
  // The whole message is covered by one verified answer ("we have a small dog, is that ok"): the pieces are one question, not two.
  if (whole && answered.length <= 1) return { answered: [{ question: text, answer: whole.answer }], unanswered: [] };
  return { answered, unanswered };
}
