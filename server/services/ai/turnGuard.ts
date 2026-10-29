import { AsyncLocalStorage } from "node:async_hooks";
import { ProcessedMessage } from "../../models";

/**
 * Makes a conversation turn safe to retry and safe to run concurrently.
 *  - Turns for the same call run one at a time (two overlapping requests can no longer interleave and corrupt the state).
 *  - A message id is processed once. A retry (network resend, double click, duplicate webhook) waits for the first
 *    attempt if it is still running, then receives the SAME result without running the agent or any backend action again.
 * Deduplication is by id, never by text, so a caller who really repeats a question gets a fresh answer.
 */
const chains = new Map<string, Promise<unknown>>();

/** Keys this async flow already holds, so a turn that calls another guarded step for the same call does not wait on itself. */
const held = new AsyncLocalStorage<Set<string>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (held.getStore()?.has(key)) return fn();
  const run = () => held.run(new Set([...(held.getStore() ?? []), key]), fn);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => undefined);
  return next;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTurnOnce<T>(callId: string, messageId: string | undefined, fn: () => Promise<T>): Promise<{ result: T; duplicate: boolean }> {
  return serialize(callId, async () => {
    if (!messageId) return { result: await fn(), duplicate: false };
    try {
      await ProcessedMessage.create({ callId, messageId, status: "processing" });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      // Seen before: return the stored result (waiting briefly if another instance is still working on it).
      for (let i = 0; i < 80; i++) {
        const row = await ProcessedMessage.findOne({ callId, messageId });
        if (row?.status === "done") return { result: row.result as T, duplicate: true };
        if (!row) break; // the first attempt failed and released its claim: run it ourselves
        await sleep(100);
      }
      return runTurnOnce(callId, messageId, fn).then((r) => ({ ...r, duplicate: true }));
    }
    try {
      const result = await fn();
      await ProcessedMessage.updateOne({ callId, messageId }, { $set: { status: "done", result: JSON.parse(JSON.stringify(result)) } });
      return { result, duplicate: false };
    } catch (e) {
      await ProcessedMessage.deleteOne({ callId, messageId }); // a failed attempt must stay retryable
      throw e;
    }
  });
}
