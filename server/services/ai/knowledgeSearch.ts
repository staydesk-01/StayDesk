import type { KnowledgeDoc } from "../../models";

const STOP = new Set(
  "a an the is are do does you your we our i me my it to of for on in at and or can could would how what when where which who do have has any there this that with be by if".split(" "),
);

/** Spoken variants -> one canonical topic word, so "can I bring my dog" finds the pet policy and "when is checkout" the check-out time. */
const SYNONYMS: Record<string, string[]> = {
  checkin: ["arrive", "arrival", "arriving"],
  checkout: ["depart", "departure", "vacate", "leave", "leaving"],
  park: ["parking", "valet", "garage", "vehicle", "car"],
  pet: ["dog", "cat", "animal", "puppy", "kitten", "pets"],
  pool: ["swim", "swimming", "swimmers"],
  breakfast: ["brunch"],
  cancel: ["cancellation", "cancelling", "canceling", "cancelled", "cancels"],
  shuttle: ["transportation", "pickup"],
};
const CANON = new Map<string, string>(Object.entries(SYNONYMS).flatMap(([canon, vs]) => vs.map((v) => [v, canon] as const)));

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/check[\s-]?in/g, " checkin ")
    .replace(/check[\s-]?out/g, " checkout ")
    .replace(/wi[\s-]?fi/g, " wifi ")
    .replace(/(get|got|have|receive)\s+(the|our|my)\s+room/g, " checkin ")
    .replace(/out of (the|our|my|your) room/g, " checkout ");

const tokens = (s: string) =>
  normalise(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t))
    .map((t) => CANON.get(t) ?? t);

export function matchFaqs(knowledge: Pick<KnowledgeDoc, "faqs"> | null, query: string, limit = 3) {
  const faqs = knowledge?.faqs ?? [];
  const q = new Set(tokens(query));
  if (!q.size) return [];
  return faqs
    .map((f) => {
      const t = new Set(tokens(`${f.question} ${f.answer}`));
      const qt = new Set(tokens(f.question));
      let score = 0;
      for (const w of q) {
        if (qt.has(w)) score += 2;
        else if (t.has(w)) score += 1;
      }
      return { f, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ question: x.f.question, answer: x.f.answer }));
}

export function matchServices(knowledge: Pick<KnowledgeDoc, "services"> | null, query: string) {
  const q = new Set(tokens(query));
  return (knowledge?.services ?? []).filter((s) => tokens(s.name).some((w) => q.has(w)));
}

/** First dollar amount in a price string, e.g. "From $189 per night" -> 189. */
export function parsePrice(price: string | undefined | null): number | null {
  const m = price?.match(/\$?\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** Words that carry no topic of their own in a price / availability question. */
const GENERIC_WORDS = new Set(
  "wait sorry quick question actually also anyway btw hmm um uh yeah hey hello just really maybe should thank thanks serve served offer offers include included includes come comes free friendly policy policies terms nightly latest earliest daily available availability long time times hour hours open opens close closes closing early late bring take allow allowed allows get got use need want like please tell know say about reservation reservations reserve ok okay fine possible there any have has does what how this that those these room rooms night nights stay stays hotel price prices pricing cost costs much rate rates fee fees charge charges cheap cheapest cheaper expensive per start starting average typical total weekend weekday tonight book booking deposit tax taxes discount discounts extra additional options option available type types many little best good big small your you does what how this that those these there want would like please tell know say about".split(" "),
);
/** Generic words are compared after the same stemming as question tokens ("terms" -> "term"). */
const stem = (t: string) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
const GENERIC = new Set([...GENERIC_WORDS, ...[...GENERIC_WORDS].map(stem)]);

/**
 * Topic words in `text` that appear NOWHERE in the business's verified information. If a caller asks
 * "what does the spa cost?" and nothing verified mentions a spa, we must not answer with some other price.
 */
export function unknownTerms(text: string, knowledge: Pick<KnowledgeDoc, "services" | "faqs" | "pricingInfo" | "policies" | "description"> | null, extraVocabulary: string[] = []): string[] {
  const corpus = new Set(
    tokens(
      [
        ...(knowledge?.services ?? []).flatMap((s) => [s.name, s.description, s.price]),
        ...(knowledge?.faqs ?? []).flatMap((f) => [f.question, f.answer]),
        knowledge?.pricingInfo ?? "",
        knowledge?.policies ?? "",
        knowledge?.description ?? "",
        ...extraVocabulary,
      ].join(" "),
    ),
  );
  return tokens(text).filter((w) => w.length > 2 && !GENERIC.has(w) && !corpus.has(w) && !/^\d+$/.test(w));
}


export interface KnowledgeAnswer {
  answer: string;
  source: "faq" | "service" | "policy" | "room";
  matchedOn: string;
}

interface Candidate {
  source: KnowledgeAnswer["source"];
  question: Set<string>;
  answerTokens: Set<string>;
  answer: string;
  label: string;
}

/**
 * Finds the ONE verified statement that answers a question, or null. It answers only when the question's topic words
 * are covered by that statement: "can I bring my dog" -> pet policy, but "is there a shuttle to the stadium" -> null
 * (we only know about the airport shuttle) and "is smoking allowed on the balcony" -> null (nothing verified about it).
 */
export function bestAnswer(
  text: string,
  knowledge: Pick<KnowledgeDoc, "faqs" | "services" | "policies"> | null,
  rooms: { name: string; nightlyRate: number }[] = [],
): KnowledgeAnswer | null {
  const q = new Set(tokens(text).filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t)));
  if (!q.size) return null;

  const policySentences = (knowledge?.policies ?? "").split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 12);
  const candidates: Candidate[] = [
    ...(knowledge?.faqs ?? []).map((f) => ({ source: "faq" as const, question: new Set(tokens(f.question)), answerTokens: new Set(tokens(f.answer)), answer: f.answer, label: f.question })),
    ...(knowledge?.services ?? []).map((sv) => ({ source: "service" as const, question: new Set(tokens(sv.name)), answerTokens: new Set(tokens(`${sv.description} ${sv.price}`)), answer: `${sv.name}${sv.description ? `: ${sv.description}` : ""}${sv.price ? ` (${sv.price})` : ""}.`, label: sv.name })),
    ...policySentences.map((sentence) => ({ source: "policy" as const, question: new Set(tokens(sentence)), answerTokens: new Set<string>(), answer: sentence, label: sentence })),
    ...rooms.map((r) => ({ source: "room" as const, question: new Set(tokens(r.name)), answerTokens: new Set<string>(), answer: `${r.name} is $${r.nightlyRate} per night.`, label: r.name })),
  ];

  let best: { c: Candidate; score: number; covered: number } | null = null;
  for (const c of candidates) {
    let score = 0;
    let covered = 0;
    for (const t of q) {
      if (c.question.has(t)) {
        score += 2;
        covered++;
      } else if (c.answerTokens.has(t)) {
        score += 1;
        covered++;
      }
    }
    if (covered && (!best || score > best.score)) best = { c, score, covered };
  }
  if (!best) return null;
  // The statement must cover (almost) everything the caller asked about; otherwise we'd be answering a different question.
  if (best.covered / q.size < 0.67 || best.score < 2) return null;
  // A question about cost can only be answered by a statement that actually contains a price (or says it's free).
  if (/\b(cost|costs|price|prices|fee|fees|charge|charges|rate|rates)\b|how much (is|are|does|do|will|would|it|for)\b/i.test(text) && !/\$\s?\d|\bfree\b|\bcomplimentary\b|\bno charge\b/i.test(best.c.answer)) return null;
  return { answer: best.c.answer, source: best.c.source, matchedOn: best.c.label };
}
