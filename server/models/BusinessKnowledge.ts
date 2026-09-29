import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

const dayHours = new Schema(
  {
    closed: { type: Boolean, default: false },
    open: { type: String, default: "09:00" }, // HH:mm, 24h
    close: { type: String, default: "17:00" }, // HH:mm, "24:00" allowed for end of day
  },
  { _id: false },
);

const knowledgeSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, unique: true },
    description: { type: String, default: "" },
    hours: {
      mon: { type: dayHours, default: () => ({}) },
      tue: { type: dayHours, default: () => ({}) },
      wed: { type: dayHours, default: () => ({}) },
      thu: { type: dayHours, default: () => ({}) },
      fri: { type: dayHours, default: () => ({}) },
      sat: { type: dayHours, default: () => ({ closed: true }) },
      sun: { type: dayHours, default: () => ({ closed: true }) },
    },
    services: [
      {
        _id: false,
        name: { type: String, required: true },
        description: { type: String, default: "" },
        price: { type: String, default: "" },
      },
    ],
    faqs: [
      {
        _id: false,
        question: { type: String, required: true },
        answer: { type: String, required: true },
      },
    ],
    pricingInfo: { type: String, default: "" },
    policies: { type: String, default: "" },
    escalationContacts: [
      {
        _id: false,
        name: { type: String, required: true },
        phone: { type: String, required: true },
        role: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true },
);

export type KnowledgeAttrs = InferSchemaType<typeof knowledgeSchema>;
export type KnowledgeDoc = HydratedDocument<KnowledgeAttrs>;
export const BusinessKnowledge = defineModel("BusinessKnowledge", knowledgeSchema);
