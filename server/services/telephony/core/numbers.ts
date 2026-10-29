import crypto from "node:crypto";
import type { Types } from "mongoose";
import { Business, BusinessPhoneNumber, PhoneConfiguration } from "../../../models";
import type { BusinessDoc, PhoneConfigDoc } from "../../../models";
import { AppError } from "../../../utils/errors";
import { normalizePhone } from "../../../utils/phone";
import { getTelephony } from "../../telephony";

const CODE_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const E164 = /^\+[1-9]\d{7,14}$/;
const hash = (code: string) => crypto.createHash("sha256").update(code).digest("hex");
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export interface AddNumberInput {
  businessId: Types.ObjectId;
  number: string;
  mode: "provider_number" | "forwarding" | "sip_direct" | "ported";
  role?: "inbound" | "outbound_caller_id" | "both";
  answerMode?: "all_calls" | "overflow";
  trunkId?: Types.ObjectId;
}

/**
 * Registers a business number. It stays unverified (calls are NOT routed to the business) until the owner proves they
 * control it with a code. The code is only ever sent to the number itself and stored hashed.
 */
export async function addNumber(input: AddNumberInput): Promise<{ id: string; delivery: "sent" | "skipped" | "failed" }> {
  const e164 = normalizePhone(input.number);
  if (!E164.test(e164)) throw AppError.badRequest("Enter the number with its country code, for example +14155550123.");
  const taken = await BusinessPhoneNumber.findOne({ e164 });
  const legacy = await PhoneConfiguration.findOne({ twilioNumber: e164, businessId: { $ne: input.businessId } });
  if ((taken && String(taken.businessId) !== String(input.businessId)) || legacy) throw AppError.conflict("That number is already connected to an account.");
  if (taken) throw AppError.conflict("That number is already added to your account.");

  const code = newCode();
  const doc = await BusinessPhoneNumber.create({
    businessId: input.businessId, e164, mode: input.mode, role: input.role ?? "inbound", answerMode: input.answerMode ?? "overflow", trunkId: input.trunkId,
    verification: { status: "pending", codeHash: hash(code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0 },
  });
  const from = process.env.TWILIO_PHONE_NUMBER;
  const delivery = from ? await getTelephony().sendSms({ from, to: e164, body: `Your StayDesk verification code is ${code}. It expires in 15 minutes.` }) : ("skipped" as const);
  return { id: String(doc._id), delivery };
}

export async function verifyNumber(businessId: Types.ObjectId, id: string, code: string): Promise<boolean> {
  const n = await BusinessPhoneNumber.findOne({ _id: id, businessId });
  if (!n) throw AppError.notFound("Number not found");
  if (n.verification?.status === "verified") return true;
  if ((n.verification?.attempts ?? 0) >= MAX_ATTEMPTS) throw AppError.forbidden("Too many attempts. Remove the number and add it again.");
  if (!n.verification?.expiresAt || n.verification.expiresAt.getTime() < Date.now()) throw AppError.badRequest("That code has expired. Remove the number and add it again.");

  const given = Buffer.from(hash(code.trim()));
  const want = Buffer.from(n.verification.codeHash ?? "");
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    await BusinessPhoneNumber.updateOne({ _id: n._id }, { $inc: { "verification.attempts": 1 } });
    return false;
  }
  await BusinessPhoneNumber.updateOne({ _id: n._id }, { $set: { "verification.status": "verified", "verification.verifiedAt": new Date(), callerIdAuthorized: n.role !== "inbound" }, $unset: { "verification.codeHash": 1 } });
  return true;
}

/**
 * Which business owns this dialled number? Only VERIFIED numbers route. Falls back to the existing PhoneConfiguration
 * mapping so current customers keep working unchanged.
 */
export async function resolveBusinessByDid(dialed: string): Promise<{ business: BusinessDoc; config: PhoneConfigDoc | null; numberId?: Types.ObjectId; answerMode?: string } | null> {
  const e164 = normalizePhone(dialed);
  if (!e164) return null;
  const n = await BusinessPhoneNumber.findOne({ e164, "verification.status": "verified" });
  if (n && n.role !== "outbound_caller_id") {
    const business = await Business.findById(n.businessId);
    if (!business) return null;
    return { business, config: await PhoneConfiguration.findOne({ businessId: n.businessId }), numberId: n._id, answerMode: n.answerMode };
  }
  const config = await PhoneConfiguration.findOne({ twilioNumber: e164 });
  if (!config) return null;
  const business = await Business.findById(config.businessId);
  return business ? { business, config } : null;
}
