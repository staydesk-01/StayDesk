import type { DayKey, DayHours } from "@/types";

export const DAYS: { key: DayKey; label: string }[] = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

export const DEFAULT_HOURS: Record<DayKey, DayHours> = {
  mon: { closed: false, open: "09:00", close: "17:00" },
  tue: { closed: false, open: "09:00", close: "17:00" },
  wed: { closed: false, open: "09:00", close: "17:00" },
  thu: { closed: false, open: "09:00", close: "17:00" },
  fri: { closed: false, open: "09:00", close: "17:00" },
  sat: { closed: true, open: "09:00", close: "17:00" },
  sun: { closed: true, open: "09:00", close: "17:00" },
};

const COMMON_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "Europe/London", "Europe/Paris", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];

export function timezoneOptions(current?: string) {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    /* older engines */
  }
  const set = new Set([...COMMON_ZONES, ...all]);
  if (current) set.add(current);
  return [...set].map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
}
