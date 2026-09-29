/**
 * Normalises a phone number to a comparable E.164-style string.
 * "(555) 010-2000" -> "+15550102000" (assumes NANP for 10-digit numbers).
 */
export function normalizePhone(input: string | undefined | null): string {
  if (!input) return "";
  const trimmed = String(input).trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** Spoken form for TTS, e.g. "+15550102000" -> "5 5 5, 0 1 0, 2 0 0 0". */
export function speakPhone(input: string): string {
  const d = input.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length === 10) return `${d.slice(0, 3).split("").join(" ")}, ${d.slice(3, 6).split("").join(" ")}, ${d.slice(6).split("").join(" ")}`;
  return d.split("").join(" ");
}
