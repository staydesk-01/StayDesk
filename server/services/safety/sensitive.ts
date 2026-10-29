/**
 * Raw payment data must never be stored, logged, or sent to a language model.
 * We detect card-like and ID-like numbers conservatively and replace them before anything is persisted.
 */

// 13-19 digits, optionally separated by single spaces or dashes ("4111 1111 1111 1111", "4111-1111-1111-1111").
const CARD_RUN = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
const SSN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;

const digitCount = (s: string) => s.replace(/\D/g, "").length;

const DIGIT_WORD = /^(zero|oh|one|two|three|four|five|six|seven|eight|nine)$/i;
/** Longest run of spoken digits ("four one one one …") or numeric tokens, counted in digits. */
function longestSpokenDigitRun(text: string): number {
  let run = 0;
  let max = 0;
  for (const tok of text.split(/[\s,.-]+/)) {
    if (DIGIT_WORD.test(tok)) run += 1;
    else if (/^\d+$/.test(tok)) run += tok.length;
    else run = 0;
    max = Math.max(max, run);
  }
  return max;
}
const SPOKEN_RUN = /(?:\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b[\s,.-]*){12,}/gi;

export function containsCardData(text: string): boolean {
  for (const m of text.matchAll(CARD_RUN)) {
    const n = digitCount(m[0]);
    if (n >= 13 && n <= 19) return true;
  }
  return longestSpokenDigitRun(text) >= 12;
}

export function containsSensitiveId(text: string): boolean {
  return SSN.test(text.replace(/\s+/g, " ")) || /\b(cvv|cvc|security code|card number|routing number|account number)\b[^.?!]{0,30}\d{3,}/i.test(text);
}

/** Replaces card numbers, SSNs and "CVV 123"-style fragments. Safe to call on any text. */
export function redactSensitive(text: string): string {
  return text
    .replace(CARD_RUN, (m) => (digitCount(m) >= 13 && digitCount(m) <= 19 ? "[card number removed]" : m))
    .replace(SPOKEN_RUN, "[card number removed] ")
    .replace(SSN, "[ID number removed]")
    .replace(/\b(cvv|cvc|security code)\b(\s*(?:is|:)?\s*)\d{3,4}\b/gi, "$1$2[removed]");
}
