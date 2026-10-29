import type { Request, Response } from "../http";
import { auth } from "../middleware/auth";
import { Business, PhoneConfiguration, User } from "../models";
import { audit } from "../services/auditService";
import { getKnowledge, getPhoneConfig, computePhoneStatus, hashPassword } from "../services/business/businessService";
import { AppError } from "../utils/errors";
import { toObjectId } from "../utils/id";
import { normalizePhone } from "../utils/phone";
import { businessPatch, knowledgePatch, routingPatch, teamCreateBody, teamUpdateBody } from "../validators/api";
import { env } from "../config/env";

export async function getBusiness(req: Request, res: Response) {
  const business = await Business.findById(auth(req).businessId);
  if (!business) throw AppError.notFound("Business not found");
  res.json({ business });
}

export async function patchBusiness(req: Request, res: Response) {
  const { businessId } = auth(req);
  const patch = businessPatch.parse(req.body);
  const business = await Business.findById(businessId);
  if (!business) throw AppError.notFound("Business not found");

  const { notificationPrefs, privacy, ...flat } = patch;
  if (flat.phone !== undefined) flat.phone = normalizePhone(flat.phone) || flat.phone;
  if (flat.escalationPhone !== undefined) flat.escalationPhone = normalizePhone(flat.escalationPhone);
  business.set(flat);
  if (notificationPrefs) for (const [k, v] of Object.entries(notificationPrefs)) business.set(`notificationPrefs.${k}`, v);
  if (privacy) for (const [k, v] of Object.entries(privacy)) business.set(`privacy.${k}`, v);
  await business.save();
  await audit(req, businessId, "business.update", "business", businessId, { fields: Object.keys(patch) });
  res.json({ business });
}

export async function getBusinessKnowledge(req: Request, res: Response) {
  res.json({ knowledge: await getKnowledge(auth(req).businessId) });
}

export async function patchBusinessKnowledge(req: Request, res: Response) {
  const { businessId } = auth(req);
  const patch = knowledgePatch.parse(req.body);
  const knowledge = await getKnowledge(businessId);
  const { hours, booking, ...rest } = patch;
  knowledge.set(rest);
  if (hours) for (const [day, value] of Object.entries(hours)) knowledge.set(`hours.${day}`, value);
  if (booking) for (const [k, v] of Object.entries(booking)) knowledge.set(`booking.${k}`, v);
  await knowledge.save();
  await audit(req, businessId, "knowledge.update", "knowledge", knowledge._id, { fields: Object.keys(patch) });
  res.json({ knowledge });
}

function integrations() {
  return {
    twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
    openai: !!env.OPENAI_API_KEY,
    email: !!env.RESEND_API_KEY,
    voiceProvider: env.VOICE_PROVIDER,
    telephonyProvider: env.TELEPHONY_PROVIDER,
  };
}

export async function getRouting(req: Request, res: Response) {
  const { businessId } = auth(req);
  const [business, config] = await Promise.all([Business.findById(businessId), getPhoneConfig(businessId)]);
  if (!business) throw AppError.notFound("Business not found");
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  res.json({
    config,
    status: computePhoneStatus(business, config),
    integrations: integrations(),
    webhooks: {
      incoming: `${base}/api/twilio/incoming`,
      status: `${base}/api/twilio/status`,
      recording: `${base}/api/twilio/recording`,
    },
  });
}

export async function patchRouting(req: Request, res: Response) {
  const { businessId } = auth(req);
  const patch = routingPatch.parse(req.body);
  const config = await getPhoneConfig(businessId);
  const business = await Business.findById(businessId);
  if (!business) throw AppError.notFound("Business not found");

  const { twilioNumber, humanNumber, existingNumber, ...rest } = patch;
  config.set(rest);
  if (existingNumber !== undefined) config.existingNumber = normalizePhone(existingNumber);
  if (humanNumber !== undefined) config.humanNumber = normalizePhone(humanNumber);
  if (twilioNumber !== undefined) {
    const normalized = normalizePhone(twilioNumber);
    if (normalized) {
      const taken = await PhoneConfiguration.findOne({ twilioNumber: normalized, businessId: { $ne: businessId } });
      if (taken) throw AppError.conflict("That number is already connected to another business");
      config.twilioNumber = normalized;
    } else {
      config.set("twilioNumber", undefined);
    }
  }
  await config.save();
  await audit(req, businessId, "routing.update", "phoneConfiguration", config._id, { fields: Object.keys(patch) });
  res.json({ config, status: computePhoneStatus(business, config) });
}

// ---- Team ------------------------------------------------------------------
export async function listTeam(req: Request, res: Response) {
  const users = await User.find({ businessId: auth(req).businessId }).sort({ createdAt: 1 });
  res.json({ users: users.map((u) => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, active: u.active })) });
}

export async function createTeamMember(req: Request, res: Response) {
  const a = auth(req);
  const body = teamCreateBody.parse(req.body);
  if (body.role === "owner" && a.role !== "owner") throw AppError.forbidden("Only an owner can create another owner");
  if (await User.exists({ email: body.email })) throw AppError.conflict("An account with that email already exists");
  const user = await User.create({
    name: body.name,
    email: body.email,
    role: body.role,
    businessId: a.businessId,
    passwordHash: await hashPassword(body.password),
  });
  await audit(req, a.businessId, "team.create", "user", user._id, { role: body.role });
  res.status(201).json({ user: { id: String(user._id), name: user.name, email: user.email, role: user.role, active: user.active } });
}

export async function updateTeamMember(req: Request, res: Response) {
  const a = auth(req);
  const patch = teamUpdateBody.parse(req.body);
  const id = toObjectId(String(req.params.id));
  const user = await User.findOne({ _id: id, businessId: a.businessId }); // tenant-scoped
  if (!user) throw AppError.notFound("User not found");
  if (String(user._id) === a.userId) throw AppError.badRequest("You can't change your own role or access");
  if ((user.role === "owner" || patch.role === "owner") && a.role !== "owner") throw AppError.forbidden("Only an owner can change owners");
  if (patch.role) user.role = patch.role;
  if (patch.active !== undefined) user.active = patch.active;
  await user.save();
  await audit(req, a.businessId, "team.update", "user", user._id, patch);
  res.json({ user: { id: String(user._id), name: user.name, email: user.email, role: user.role, active: user.active } });
}
