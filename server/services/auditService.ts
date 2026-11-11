import type { Request } from "../http";
import type { Types } from "mongoose";
import { AuditLog } from "../models";
import { logger } from "../config/logger";

export async function audit(
  req: Request | null,
  businessId: Types.ObjectId,
  action: string,
  entity?: string,
  entityId?: unknown,
  meta?: Record<string, unknown>,
  actor: { type: "user" | "agent" | "system" | "webhook"; id?: string } = { type: "user", id: req?.auth?.userId },
) {
  try {
    await AuditLog.create({
      businessId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      entity,
      entityId: entityId ? String(entityId) : undefined,
      meta,
      ip: req?.ip,
    });
  } catch (e) {
    logger.error("Audit log write failed", { message: (e as Error).message });
  }
}

/** For access to recordings and other sensitive data: if the access cannot be logged, it does not happen. */
export async function auditRequired(req: Request | null, businessId: Types.ObjectId, action: string, entity: string, entityId: unknown, meta?: Record<string, unknown>) {
  await AuditLog.create({ businessId, actorType: "user", actorId: req?.auth?.userId, action, entity, entityId: String(entityId), meta, ip: req?.ip });
}
