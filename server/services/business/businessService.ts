import bcrypt from "bcryptjs";
import type { Types } from "mongoose";
import { env } from "../../config/env";
import { Business, BusinessKnowledge, PhoneConfiguration, User } from "../../models";
import type { BusinessDoc, BusinessType, PhoneConfigDoc, Role } from "../../models";
import { AppError } from "../../utils/errors";
import { normalizePhone } from "../../utils/phone";

export const hashPassword = (pw: string) => bcrypt.hash(pw, env.isTest ? 4 : 12);

export async function createBusinessWithOwner(input: {
  businessName: string;
  name: string;
  email: string;
  password: string;
  businessType?: BusinessType;
}) {
  const email = input.email.toLowerCase();
  if (await User.exists({ email })) throw AppError.conflict("An account with that email already exists");

  const business = await Business.create({
    name: input.businessName,
    type: input.businessType ?? "other",
    ownerEmail: email,
  });
  await Promise.all([
    BusinessKnowledge.create({ businessId: business._id }),
    PhoneConfiguration.create({ businessId: business._id }),
  ]);
  const user = await User.create({
    email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    role: "owner" as Role,
    businessId: business._id,
  });
  return { business, user };
}

/** Finds the business that owns a dialled number (matched against the StayDesk/Twilio number). */
export async function findBusinessByNumber(dialed: string): Promise<{ business: BusinessDoc; config: PhoneConfigDoc } | null> {
  const number = normalizePhone(dialed);
  if (!number) return null;
  const config = await PhoneConfiguration.findOne({ twilioNumber: number });
  if (!config) return null;
  const business = await Business.findById(config.businessId);
  return business ? { business, config } : null;
}

export async function getPhoneConfig(businessId: Types.ObjectId) {
  return (
    (await PhoneConfiguration.findOne({ businessId })) ?? (await PhoneConfiguration.create({ businessId }))
  );
}

export async function getKnowledge(businessId: Types.ObjectId) {
  return (await BusinessKnowledge.findOne({ businessId })) ?? (await BusinessKnowledge.create({ businessId }));
}

/** Number used for human-first ringing and AI → human transfers. */
export function resolveHumanNumber(business: Pick<BusinessDoc, "escalationPhone">, config: Pick<PhoneConfigDoc, "humanNumber">): string {
  return normalizePhone(config.humanNumber || business.escalationPhone);
}

export interface PhoneStatus {
  phoneConnected: boolean;
  forwardingConfigured: boolean;
  agentActive: boolean;
  humanFallbackConfigured: boolean;
}

export function computePhoneStatus(business: BusinessDoc, config: PhoneConfigDoc): PhoneStatus {
  const phoneConnected = !!config.twilioNumber;
  return {
    phoneConnected,
    forwardingConfigured: config.mode === "new_twilio" ? phoneConnected : !!config.forwardingConfigured && phoneConnected,
    agentActive: !!config.agentActive && phoneConnected,
    humanFallbackConfigured: !!resolveHumanNumber(business, config),
  };
}
