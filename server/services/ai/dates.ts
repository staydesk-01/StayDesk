/**
 * Spoken-date understanding for stay/appointment requests. All dates are local calendar dates as "YYYY-MM-DD".
 * Deliberately conservative: when something is ambiguous ("next week", "sometime in May") it reports `ambiguous`
 * so the agent asks instead of guessing.
 */

export type DateKey = string;

const toUtc = (d: DateKey) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
};
const fromUtc = (dt: Date): DateKey => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;

export const addDays = (d: DateKey, n: number): DateKey => fromUtc(new Date(toUtc(d).getTime() + n * 86_400_000));
export const diffDays = (a: DateKey, b: DateKey): number => Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
/** 0 = Sunday … 6 = Saturday */
export const weekday = (d: DateKey): number => toUtc(d).getUTCDay();

export function isValidDateKey(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return fromUtc(toUtc(d)) === d;
}

/** Every night from checkIn up to (not including) checkOut. */
export function nightsBetween(checkIn: DateKey, checkOut: DateKey): DateKey[] {
  const out: DateKey[] = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) out.push(d);
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14 };
export const wordToNumber = (w: string): number | undefined => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w.toLowerCase()]);

interface Found {
  at: number;
  date: DateKey;
}

export interface StayParse {
  checkIn?: DateKey;
  checkOut?: DateKey;
  nights?: number;
  /** The caller said something date-like we could not pin down (ask a clarifying question). */
  ambiguous?: boolean;
  /** Parsed dates that are before today. */
  inPast?: boolean;
}

function monthDay(month: number, day: number, today: DateKey, explicitYear?: number): DateKey | null {
  const year = explicitYear ?? Number(today.slice(0, 4));
  let d = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidDateKey(d)) return null;
  if (explicitYear === undefined && d < today) {
    d = `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; // "March 3" said in October means next March
    if (!isValidDateKey(d)) return null;
  }
  return d;
}

function nextWeekday(target: number, today: DateKey, mode: "plain" | "next"): DateKey {
  if (mode === "next") {
    // first such weekday on/after the Monday that starts next week
    const daysToNextMonday = ((8 - weekday(today)) % 7) || 7;
    const nextMonday = addDays(today, daysToNextMonday);
    return addDays(nextMonday, (target - weekday(nextMonday) + 7) % 7);
  }
  return addDays(today, (target - weekday(today) + 7) % 7);
}

const lev = (a: string, b: string) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
};
const DATE_VOCAB = ["tomorrow", "tonight", "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", ...Object.keys(MONTHS).filter((m) => m.length >= 5)];

/**
 * Speech-to-text slips ("tomorow", "wensday", "octobar") -> the intended word. Only words of 5+ letters that are one or two
 * edits from a date word are corrected, so ordinary words are never rewritten.
 */
export function fixDateTypos(text: string): string {
  return text
    .replace(/\b(to|too)\s+nights?\b/gi, "two nights") // "for to nights" is almost always "two nights"
    .replace(/[A-Za-z]{5,}/g, (w) => {
      const lw = w.toLowerCase();
      if (DATE_VOCAB.includes(lw)) return w;
      const best = DATE_VOCAB.map((v) => ({ v, d: lev(lw, v) })).sort((a, b) => a.d - b.d)[0];
      return best && best.d <= (lw.length >= 8 ? 2 : 1) && Math.abs(best.v.length - lw.length) <= 2 ? best.v : w;
    });
}

/** Pulls every recognisable date out of `text`, in the order spoken. */
export function extractDates(text: string, today: DateKey): { dates: Found[]; ambiguous: boolean } {
  const t = fixDateTypos(text).toLowerCase().replace(/[,]/g, " ");
  const found: Found[] = [];
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && b > x);
  const add = (at: number, len: number, date: DateKey | null) => {
    if (!date || overlaps(at, at + len)) return;
    taken.push([at, at + len]);
    found.push({ at, date });
  };

  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m.index!, m[0].length, isValidDateKey(m[0]) ? m[0] : null);

  // 10/25 or 10/25/2026
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    add(m.index!, m[0].length, monthDay(Number(m[1]), Number(m[2]), today, y));
  }

  // "october 25", "oct 25th 2026"
  const monthNames = Object.keys(MONTHS).join("|");
  for (const m of t.matchAll(new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`, "g"))) {
    add(m.index!, m[0].length, monthDay(MONTHS[m[1]], Number(m[2]), today, m[3] ? Number(m[3]) : undefined));
  }
  // "25th of october", "the 25 october"
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})\\b(?:\\s+(\\d{4}))?`, "g"))) {
    add(m.index!, m[0].length, monthDay(MONTHS[m[2]], Number(m[1]), today, m[3] ? Number(m[3]) : undefined));
  }

  for (const m of t.matchAll(/\bday after tomorrow\b/g)) add(m.index!, m[0].length, addDays(today, 2));
  for (const m of t.matchAll(/\b(tomorrow|tmrw)\b/g)) add(m.index!, m[0].length, addDays(today, 1));
  for (const m of t.matchAll(/\b(today|tonight|this evening)\b/g)) add(m.index!, m[0].length, today);

  const dayNames = Object.keys(WEEKDAYS).join("|");
  for (const m of t.matchAll(new RegExp(`\\b(?:(this|next|coming)\\s+)?(${dayNames})\\b`, "g"))) {
    add(m.index!, m[0].length, nextWeekday(WEEKDAYS[m[2]], today, m[1] === "next" ? "next" : "plain"));
  }

  // "the 25th" (day of month only): this month if still ahead, else next month
  for (const m of t.matchAll(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/g)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    const day = Number(m[1]);
    const [y, mo] = today.split("-").map(Number);
    let d: DateKey | null = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!isValidDateKey(d) || d < today) {
      const ny = mo === 12 ? y + 1 : y;
      const nm = mo === 12 ? 1 : mo + 1;
      d = `${ny}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!isValidDateKey(d)) d = null;
    }
    add(m.index!, m[0].length, d);
  }

  found.sort((a, b) => a.at - b.at);
  const vague = /\b(next week|this week|weekend|sometime|some time|next month|this month|few days|couple of days|end of the month|whenever|flexible)\b/.test(t);
  return { dates: found, ambiguous: vague && found.length === 0 };
}

/** Number of nights mentioned ("2 nights", "two nights", "a week"). */
export function extractNights(text: string): number | undefined {
  const t = fixDateTypos(text).toLowerCase();
  const m = t.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen)[\s-]+nights?\b/);
  if (m) return wordToNumber(m[1]);
  if (/\b(a|one) week\b/.test(t)) return 7;
  if (/\btwo weeks\b/.test(t)) return 14;
  return undefined;
}

export function parseStay(text: string, today: DateKey): StayParse {
  const { dates, ambiguous } = extractDates(text, today);
  const nights = extractNights(text);
  const out: StayParse = { ambiguous };
  if (dates[0]) {
    out.checkIn = dates[0].date;
    if (dates[1]) {
      let checkOut = dates[1].date;
      // "Friday to Sunday" / "the 3rd to the 5th": the second date must come after the first
      if (checkOut <= out.checkIn) {
        const bumped = addDays(checkOut, 7);
        checkOut = diffDays(out.checkIn, bumped) <= 14 && /\b(mon|tue|wed|thu|fri|sat|sun)/.test(text.toLowerCase()) ? bumped : checkOut;
      }
      if (checkOut > out.checkIn) out.checkOut = checkOut;
      else out.ambiguous = true;
    } else if (nights) {
      out.checkOut = addDays(out.checkIn, nights);
    }
    if (out.checkOut) out.nights = diffDays(out.checkIn, out.checkOut);
    else if (nights) out.nights = nights;
    if (out.checkIn < today) out.inPast = true;
  } else if (nights) {
    out.nights = nights;
  }
  return out;
}

/** "Friday, October 23" for speech. */
export function speakDate(d: DateKey): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(toUtc(d));
}
