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
    /** Reservation terms the agent may quote. Unset (null) means "not verified": the agent says so instead of guessing. */
    booking: {
      taxRatePercent: { type: Number, default: null, min: 0, max: 100 },
      /** none: no payment asked. after_booking: reservation is made, then a deposit request goes to staff. to_confirm: nothing is confirmed until staff receive the deposit. */
      depositPolicy: { type: String, enum: ["none", "after_booking", "to_confirm"], default: "none" },
      depositPercent: { type: Number, default: 0, min: 0, max: 100 },
    },
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
