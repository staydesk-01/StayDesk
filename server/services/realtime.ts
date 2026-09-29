import type { Types } from "mongoose";

/**
 * Live-update hook. A single Next.js app has no long-lived WebSocket server, so the dashboard refreshes by
 * polling (see hooks/use-api.ts). Services still call publish() at every change, which keeps the seam in place:
 * to add push updates later (SSE / Pusher / Ably) implement it here without touching callers.
 */
export type RealtimeEvent = "call.created" | "call.updated" | "notification.created" | "followup.updated" | "opportunity.updated";

export function publish(_businessId: Types.ObjectId | string, _event: RealtimeEvent, _payload: Record<string, unknown> = {}) {
  /* polling clients pick changes up on their next refresh */
}
