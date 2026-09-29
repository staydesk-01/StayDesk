import type { KnowledgeDoc } from "../../models";

const STOP = new Set(
  "a an the is are do does you your we our i me my it to of for on in at and or can could would how what when where which who do have has any there this that with be by if".split(" "),
);

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));

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
