import { Business, Call, CallTranscript } from "../models";
import { logger } from "../config/logger";

/** Deletes transcripts older than each business's configured retention window. */
export async function purgeExpiredTranscripts() {
  const businesses = await Business.find().select("privacy");
  let removed = 0;
  for (const b of businesses) {
    const days = b.privacy?.transcriptRetentionDays ?? 90;
    const cutoff = new Date(Date.now() - days * 86400_000);
    const old = await CallTranscript.find({ businessId: b._id, createdAt: { $lt: cutoff } }).select("callId");
    if (!old.length) continue;
    await CallTranscript.deleteMany({ _id: { $in: old.map((t) => t._id) } });
    await Call.updateMany({ _id: { $in: old.map((t) => t.callId) } }, { $unset: { transcriptId: 1 } });
    removed += old.length;
  }
  if (removed) logger.info(`Retention: purged ${removed} expired transcripts`);
  return removed;
}

let lastRun = 0;
/** Fire-and-forget, at most every 6 hours per server process (there is no separate scheduler in a single Next app). */
export function maybePurgeExpiredTranscripts() {
  if (process.env.NODE_ENV === "test" || Date.now() - lastRun < 6 * 3600_000) return;
  lastRun = Date.now();
  void purgeExpiredTranscripts().catch((e) => logger.error("Retention job failed", { message: (e as Error).message }));
}
