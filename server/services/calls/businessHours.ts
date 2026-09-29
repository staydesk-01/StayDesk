export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const DAY_KEYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABELS: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export interface DayHours {
  closed?: boolean;
  open?: string | null;
  close?: string | null;
}
export type WeekHours = Partial<Record<DayKey, DayHours | null | undefined>>;

const toMinutes = (hhmm: string | null | undefined, fallback: number) => {
  if (!hhmm) return fallback;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : fallback;
};

/** Local weekday + minutes-since-midnight for `date` in `timezone`. */
export function localParts(date: Date, timezone: string): { day: DayKey; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday").slice(0, 3).toLowerCase() as DayKey;
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isOpenAt(hours: WeekHours | undefined | null, timezone: string, date = new Date()): boolean {
  if (!hours) return true; // no schedule configured -> treat as always open (human-first)
  const { day, minutes } = localParts(date, timezone);
  const today = hours[day];
  if (today && !today.closed) {
    const open = toMinutes(today.open, 0);
    const close = toMinutes(today.close, 24 * 60);
    if (open <= close ? minutes >= open && minutes < close : minutes >= open) return true;
  }
  // Overnight window that started yesterday (e.g. 18:00 - 02:00).
  const yesterday = hours[DAY_KEYS[(DAY_KEYS.indexOf(day) + 6) % 7]];
  if (yesterday && !yesterday.closed) {
    const yo = toMinutes(yesterday.open, 0);
    const yc = toMinutes(yesterday.close, 24 * 60);
    if (yo > yc && minutes < yc) return true;
  }
  return false;
}

export function formatTime(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  if (hhmm === "24:00") return "12:00 AM";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, "0")} ${suffix}`;
}

function describeDay(d: DayHours | null | undefined): string {
  if (!d || d.closed) return "closed";
  if (d.open === "00:00" && (d.close === "24:00" || d.close === "23:59")) return "open 24 hours";
  return `${formatTime(d.open)} to ${formatTime(d.close)}`;
}

/** Compresses consecutive identical days: "Monday to Friday: 9:00 AM to 5:00 PM; Saturday and Sunday: closed". */
export function formatHours(hours: WeekHours | undefined | null): string {
  if (!hours) return "Hours have not been set.";
  const groups: { days: DayKey[]; text: string }[] = [];
  for (const key of DAY_KEYS) {
    const text = describeDay(hours[key]);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.days.push(key);
    else groups.push({ days: [key], text });
  }
  return groups
    .map(({ days, text }) => {
      const label =
        days.length === 1
          ? DAY_LABELS[days[0]]
          : days.length === 2
            ? `${DAY_LABELS[days[0]]} and ${DAY_LABELS[days[1]]}`
            : `${DAY_LABELS[days[0]]} to ${DAY_LABELS[days[days.length - 1]]}`;
      return `${label}: ${text}`;
    })
    .join("; ");
}

/** UTC instant of local midnight (start of "today") in `timezone`. */
export function startOfLocalDay(date: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  const offset = asUtc - Math.floor(date.getTime() / 1000) * 1000; // tz offset at `date`
  return new Date(Date.UTC(n("year"), n("month") - 1, n("day")) - offset);
}

/** "YYYY-MM-DD" of `date` in `timezone` (used for chart buckets). */
export function localDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
