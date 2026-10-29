/** Small shared extractors for spoken answers (names, confirmation codes, guest counts, yes/no). */
import { wordToNumber } from "./dates";

const NOT_NAMES = new Set("zero one two three four five six seven eight nine ten guest guests people persons nights night room rooms thanks thank today tomorrow tonight deluxe king queen suite family looking calling interested trying just not here wondering hoping having need needing wanting want would calling from in at the a an and so um uh yes yeah no sure okay ok please book booking reserve reservation callback call back follow up it that this don't dont do not thanks cancel change stop help".split(" "));
const TRAILING = new Set("and calling from i looking need would want in at for to with about because".split(" "));

export const cap = (s: string) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

export function extractName(text: string, strict = false): string | undefined {
  const m = text.match(/\b(?:my name is|my name's|name is|this is|i am|i'm|it's|its|call me)\s+([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,2})/i);
  let candidate = m?.[1];
  if (!candidate && strict) {
    const words = text.replace(/[.,!?]/g, "").trim().split(/\s+/);
    if (words.length <= 3 && !/\d/.test(text)) candidate = words.join(" ");
  }
  if (!candidate) return undefined;
  const parts = candidate.split(/\s+/);
  while (parts.length && TRAILING.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  if (!parts.length || parts.some((p) => NOT_NAMES.has(p.toLowerCase()))) return undefined;
  return cap(parts.slice(0, 2).join(" ").toLowerCase());
}


export const YES = /\b(yes|yeah|yep|yup|sure|please|okay|ok|absolutely|definitely|correct|that'?s right|right|go ahead|do it|book it|confirm|sounds good|that would be great)\b/i;
export const NO = /\b(no|nope|nah|not now|don'?t|do not|no thanks?|no thank you|wrong|incorrect|not right|change)\b/i;

/** "SD-AB12CD", "S D A B 1 2 C D", "sd ab12cd" -> "SD-AB12CD" (letters/digits only, no 0/1/O/I/L). */
export function extractCode(text: string): string | undefined {
  // "SD" must start a word, otherwise "my name is Dana Reed" would read as SD-ANAREE across word boundaries.
  const m = text.toUpperCase().match(/\bS\s?D[\s,.\-]*((?:[A-HJKMNP-Z2-9][\s,.\-]*){6})/);
  if (!m) return undefined;
  const body = m[1].replace(/[^A-Z0-9]/g, "");
  return body.length === 6 ? `SD-${body}` : undefined;
}

/** Number of guests: "for two", "3 adults", "party of 4", "just me", "my wife and I". */
export function extractGuests(text: string, bare = false): number | undefined {
  const t = text.toLowerCase();
  if (/\bjust me\b|\bonly me\b|\bby myself\b|\bsolo\b/.test(t)) return 1;
  if (/\b(me and my (wife|husband|partner|girlfriend|boyfriend|spouse)|my (wife|husband|partner) and (i|me)|a couple|the two of us|both of us)\b/.test(t)) return 2;
  const m =
    t.match(/\b(\d+|one|two|three|four|five|six|seven|eight)\s*(guests?|people|persons?|adults?|of us|travell?ers?|pax)\b/) ??
    t.match(/\b(?:for|party of|group of|with)\s+(\d+|one|two|three|four|five|six|seven|eight)\b(?!\s*(nights?|days?|weeks?))/);
  if (m) return wordToNumber(m[1]);
  if (bare) {
    const b = t.replace(/[.,!?]/g, "").trim().match(/^(\d+|one|two|three|four|five|six|seven|eight)(\s+please)?$/);
    if (b) return wordToNumber(b[1]);
  }
  return undefined;
}

/** Spoken-friendly code: "SD-AB12CD" -> "S D, A B 1 2 C D". */
export const speakCode = (code: string) => `S D, ${code.replace(/^SD-/, "").split("").join(" ")}`;

/** "no, that's not right" contains the word "right": negatives win over positives. */
export const isNo = (t: string) => NO.test(t) && !/^\s*(yes|yeah|yep|sure|ok|okay|absolutely)\b/i.test(t);
export const isYes = (t: string) => YES.test(t) && !isNo(t);

/** A bare acknowledgement or command ("ok book it", "yes please", "go ahead"): agreement, not information. */
export const ACK_ONLY = /^\s*(ok(ay)?|yes|yeah|yep|sure|please|go ahead|do it|book it|sounds good|that works|fine|alright|all right)([\s,.!]+(ok(ay)?|yes|please|book it|go ahead|do it|thanks|thank you|now|then))*[\s.!]*$/i;

export function extractEmail(text: string): string | undefined {
  const m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/);
  return m ? m[0].toLowerCase() : undefined;
}

/** A phone number spoken or typed with at least 10 digits ("805 555 0142", "eight oh five..." is not handled). */
export function extractPhone(text: string): string | undefined {
  const digits = text.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return undefined;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}
