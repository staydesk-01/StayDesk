import { z } from "zod";
import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { Business } from "../models";
import { audit } from "../services/auditService";
import { concurrencyMetrics } from "../services/telephony/concurrency/metrics";

const settings = z.object({ maxConcurrentCalls: z.coerce.number().int().min(1).max(1000), overflowPolicy: z.enum(["callback", "transfer", "voicemail"]) });

export async function getConcurrency(req: Request, res: Response) {
  const { businessId } = auth(req);
  res.json(await concurrencyMetrics(businessId));
}

export async function putConcurrency(req: Request, res: Response) {
  const a = auth(req);
  const b = settings.parse(req.body);
  await Business.updateOne({ _id: a.businessId }, { $set: { "concurrency.maxConcurrentCalls": b.maxConcurrentCalls, "concurrency.overflowPolicy": b.overflowPolicy } });
  await audit(req, a.businessId, "concurrency.updated", "business", String(a.businessId), b);
  res.json(await concurrencyMetrics(a.businessId));
}
