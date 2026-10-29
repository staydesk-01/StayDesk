import { z } from "zod";
import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { CustomerProfile } from "../models";
import { audit } from "../services/auditService";
import { forgetCaller } from "../services/memory/customerMemory";
import { AppError } from "../utils/errors";

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const forgetQuery = z.object({ optOut: z.enum(["true", "false"]).default("false") });

/** What StayDesk remembers about returning callers of THIS business (owners/admins only: it is personal data). */
export async function listCustomers(req: Request, res: Response) {
  const { businessId } = auth(req);
  const { limit } = listQuery.parse(req.query);
  const customers = await CustomerProfile.find({ businessId, optedOut: false }).sort({ lastCallAt: -1 }).limit(limit);
  res.json({ customers });
}

/** Erase a caller's remembered data (right to be forgotten). `?optOut=true` also stops future remembering. */
export async function deleteCustomer(req: Request, res: Response) {
  const a = auth(req);
  const { optOut } = forgetQuery.parse(req.query);
  const id = String(req.params.id);
  if (!/^[a-f0-9]{24}$/i.test(id)) throw AppError.notFound("Customer not found");
  const done = await forgetCaller(a.businessId, id, { optOut: optOut === "true" });
  if (!done) throw AppError.notFound("Customer not found");
  await audit(req, a.businessId, optOut === "true" ? "customer.opt_out" : "customer.forget", "customerProfile", id);
  res.json({ ok: true });
}
