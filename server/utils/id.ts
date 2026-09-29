import { Types } from "mongoose";
import { AppError } from "./errors";

export function toObjectId(id: string | Types.ObjectId | undefined | null): Types.ObjectId {
  if (!id || !Types.ObjectId.isValid(String(id))) throw AppError.badRequest("Invalid id");
  return new Types.ObjectId(String(id));
}
