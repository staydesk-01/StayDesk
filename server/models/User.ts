import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";
import { ROLES } from "./enums";

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ROLES, required: true, default: "staff" },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    /** Reserved for Clerk: map a Clerk user id to this user when auth is swapped. */
    clerkId: { type: String, index: true, sparse: true },
    active: { type: Boolean, default: true },
    /** Time-based one-time-password second factor. The secret is stored encrypted; recovery codes only as hashes. */
    mfa: {
      enabled: { type: Boolean, default: false },
      secretCipher: { type: String, select: false },
      pendingSecretCipher: { type: String, select: false },
      recoveryHashes: { type: [String], default: [], select: false },
      lastUsedStep: { type: Number, default: 0, select: false },
      enrolledAt: Date,
    },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = defineModel("User", userSchema);
