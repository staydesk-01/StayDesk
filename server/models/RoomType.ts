import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

/** Bookable inventory for a business (hotel room types; the same shape works for tables / appointment slots later). */
const roomTypeSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    nightlyRate: { type: Number, required: true, min: 0 },
    capacity: { type: Number, default: 2, min: 1 },
    /** How many rooms of this type exist. Availability = totalUnits minus overlapping confirmed reservations. */
    totalUnits: { type: Number, required: true, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
roomTypeSchema.index({ businessId: 1, name: 1 }, { unique: true });

export type RoomTypeAttrs = InferSchemaType<typeof roomTypeSchema>;
export type RoomTypeDoc = HydratedDocument<RoomTypeAttrs>;
export const RoomType = defineModel("RoomType", roomTypeSchema);
