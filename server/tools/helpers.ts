import type { Types } from "mongoose";
import type { RoomOption } from "../services/booking";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter((w) => w.length > 1 && !["room", "the", "a", "an", "with"].includes(w));

/** Matches what the caller/LLM said ("ocean view", "the king room") to a room type offered by the booking system. */
export function resolveRoom(options: RoomOption[], wanted: string): { match?: RoomOption; ambiguous?: RoomOption[] } {
  const exact = options.find((o) => norm(o.name) === norm(wanted));
  if (exact) return { match: exact };
  const w = words(wanted);
  if (!w.length) return {};
  let scored = options
    .map((o) => ({ o, hits: w.filter((x) => words(o.name).includes(x)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  // Speech-to-text slips ("dlux kingg"): only when nothing matched exactly, accept words that are a small edit away.
  if (!scored.length) {
    scored = options
      .map((o) => ({ o, hits: w.filter((x) => x.length >= 4 && words(o.name).some((y) => y.length >= 4 && editDistance(x, y) <= Math.floor(Math.max(x.length, y.length) / 3))).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits);
  }
  if (!scored.length) return {};
  const best = scored.filter((x) => x.hits === scored[0].hits);
  return best.length === 1 ? { match: best[0].o } : { ambiguous: best.map((b) => b.o) };
}

export const isObjectId = (v: unknown): v is Types.ObjectId => typeof v === "object" && v !== null;

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
