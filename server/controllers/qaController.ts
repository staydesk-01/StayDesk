import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { QA_STATUSES, QaResult } from "../models";
import { audit } from "../services/auditService";
import { AppError } from "../utils/errors";

/** The 12 scenarios from the concurrency test plan. `auto` names the automated simulated check that covers it, if any. */
export const SCENARIOS = [
  { id: "one", name: "One caller through the business number", concurrency: 1, auto: "single" },
  { id: "two", name: "Two callers simultaneously", concurrency: 2, auto: "sim-2" },
  { id: "five", name: "Five callers simultaneously", concurrency: 5, auto: "sim-5" },
  { id: "ten", name: "Ten callers simultaneously", concurrency: 10, auto: "sim-10" },
  { id: "ten-different", name: "Ten different conversations with different requests", concurrency: 10, auto: "diff-10" },
  { id: "ten-recordings", name: "Ten independent recordings and transcripts", concurrency: 10, auto: "rec-book-10" },
  { id: "ten-bookings", name: "Ten separate booking or order requests (no duplicates)", concurrency: 10, auto: "rec-book-10" },
  { id: "transfer", name: "Human transfer while other AI sessions stay active", concurrency: 5, auto: "transfer-isolated" },
  { id: "one-fails", name: "One session failing while the rest continue", concurrency: 5, auto: "one-fails" },
  { id: "capacity", name: "Calls arriving when configured capacity is reached", concurrency: 5, auto: "capacity" },
  { id: "retries", name: "Twilio webhook retries and duplicate events", concurrency: 2, auto: "dup-events" },
  { id: "network", name: "Network interruptions and recovery", concurrency: 1, auto: "lost-end" },
] as const;
const SIMULTANEOUS = new Set(["two", "five", "ten"]);

function readReport(): { generatedAt?: string; warning?: string; results: { id: string; status: string; detail: string }[] } | null {
  try { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "evals/reports/concurrency.json"), "utf8")); } catch { return null; }
}

export async function concurrencyTests(req: Request, res: Response) {
  const { businessId } = auth(req);
  const [saved, report] = [await QaResult.find({ businessId }), readReport()];
  const live = new Map(saved.map((r) => [r.scenarioId, r]));
  const scenarios = SCENARIOS.map((s) => {
    const a = report?.results.find((r) => r.id === s.auto);
    const l = live.get(s.id);
    return {
      id: s.id, name: s.name, concurrency: s.concurrency,
      automated: a ? { status: a.status, detail: a.detail } : { status: "not_tested" as const, detail: "No automated run recorded. Run: CONCURRENCY_REPORT=1 npx vitest run tests/live-sessions.test.ts" },
      live: l ? { status: l.status, notes: l.notes, concurrency: l.concurrency, testedBy: l.testedBy, testedAt: l.testedAt } : { status: "not_tested" as const },
    };
  });
  // Capacity is "verified" only by a person recording a passing LIVE test with the real Twilio account.
  const verified = Math.max(0, ...saved.filter((r) => SIMULTANEOUS.has(r.scenarioId) && r.status === "pass").map((r) => r.concurrency ?? 0));
  res.json({
    scenarios,
    automatedRun: report && { generatedAt: report.generatedAt, warning: report.warning },
    verifiedConcurrentCalls: verified,
    verifiedNote: verified ? `A live test with ${verified} simultaneous callers was recorded as passed.` : "No live test has been recorded. Automated results are simulated and do not prove capacity with Twilio, speech recognition or text-to-speech.",
  });
}

const body = z.object({ status: z.enum(QA_STATUSES), notes: z.string().trim().max(2000).default(""), concurrency: z.number().int().min(0).max(1000).optional() });
export async function recordConcurrencyResult(req: Request, res: Response) {
  const a = auth(req);
  const id = String(req.params.id);
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc) throw AppError.notFound("Unknown scenario");
  const b = body.parse(req.body);
  if (b.status === "pass" && SIMULTANEOUS.has(id) && (b.concurrency ?? 0) < sc.concurrency) throw AppError.badRequest(`Record how many callers were on the line at once (at least ${sc.concurrency}) to mark this passed.`, "concurrency_required");
  await QaResult.updateOne({ businessId: a.businessId, scenarioId: id }, { $set: { ...b, testedBy: a.name, testedAt: new Date() } }, { upsert: true });
  await audit(req, a.businessId, "qa.result_recorded", "qa", id, { status: b.status, concurrency: b.concurrency });
  res.json({ ok: true });
}
