import type { Types } from "mongoose";
import { nativeBookingProvider } from "./nativeProvider";
import type { BookingProvider } from "./provider";

export * from "./provider";
export { newConfirmationCode } from "./nativeProvider";

/** Providers in priority order. Add a PMS / calendar adapter here; the first configured one serves the business. */
const providers: BookingProvider[] = [nativeBookingProvider];

/** The booking system for this business, or null when none is set up (the agent then captures an inquiry instead). */
export async function getBookingProvider(businessId: Types.ObjectId): Promise<BookingProvider | null> {
  for (const p of providers) if (await p.isConfigured(businessId)) return p;
  return null;
}

/** Test seam: replace/restore the provider list. */
export function __setProvidersForTest(list: BookingProvider[] | null) {
  providers.splice(0, providers.length, ...(list ?? [nativeBookingProvider]));
}

/** Phone-last-10 or last-name match: how a caller proves a reservation is theirs. */
export function guestMatches(rec: { guestName: string; guestPhone: string }, who: { phone?: string; lastName?: string }): boolean {
  const digits = (s?: string) => (s ?? "").replace(/\D/g, "").slice(-10);
  if (who.phone && digits(rec.guestPhone) && digits(who.phone) === digits(rec.guestPhone)) return true;
  const last = rec.guestName.trim().split(/\s+/).pop()?.toLowerCase();
  return !!(who.lastName && last && who.lastName.trim().toLowerCase() === last);
}
