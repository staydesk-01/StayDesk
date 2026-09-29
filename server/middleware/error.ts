import mongoose from "mongoose";
import { ZodError, z } from "zod";
import { logger } from "../config/logger";
import { AppError } from "../utils/errors";

/** Maps any thrown value to a safe JSON error. Never leaks stack traces or internals to the client. */
export function toErrorResponse(err: unknown, method = "", path = ""): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  const e = err as { code?: number | string; message?: string; stack?: string; name?: string };
  if (err instanceof ZodError) {
    return { status: 400, body: { error: { code: "validation_error", message: "Invalid input", details: z.flattenError(err).fieldErrors } } };
  }
  if (err instanceof AppError) return { status: err.status, body: { error: { code: err.code ?? "error", message: err.message } } };
  if (err instanceof mongoose.Error.CastError) return { status: 400, body: { error: { code: "invalid_id", message: "Invalid identifier" } } };
  if (e?.code === 11000) return { status: 409, body: { error: { code: "duplicate", message: "That record already exists" } } };
  if (e?.name === "MongoConnectionError") {
    return { status: 503, body: { error: { code: "database_unavailable", message: "The database is unavailable. Is MongoDB running?" } } };
  }
  logger.error(`Unhandled error on ${method} ${path}`, { message: e?.message, stack: e?.stack });
  return { status: 500, body: { error: { code: "internal_error", message: "Something went wrong" } } };
}
