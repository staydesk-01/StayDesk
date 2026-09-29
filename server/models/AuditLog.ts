import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

const auditLogSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    actorType: { type: String, enum: ["user", "agent", "system", "webhook"], required: true },
    actorId: { type: String },
    action: { type: String, required: true },
    entity: { type: String },
    entityId: { type: String },
    meta: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ businessId: 1, createdAt: -1 });

export type AuditLogAttrs = InferSchemaType<typeof auditLogSchema>;
export type AuditLogDoc = HydratedDocument<AuditLogAttrs>;
export const AuditLog = defineModel("AuditLog", auditLogSchema);
