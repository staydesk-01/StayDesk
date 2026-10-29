import { Schema, InferSchemaType, HydratedDocument } from "mongoose";
import { defineModel } from "./_define";

/**
 * Atomic per-night occupancy counter for one room type. Booking increments it with a conditional update
 * (`used < totalUnits`), which MongoDB applies atomically, so two simultaneous callers can never both take the last room.
 */
const roomNightSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    roomTypeId: { type: Schema.Types.ObjectId, ref: "RoomType", required: true },
    night: { type: String, required: true }, // YYYY-MM-DD
    used: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);
roomNightSchema.index({ businessId: 1, roomTypeId: 1, night: 1 }, { unique: true });

export type RoomNightAttrs = InferSchemaType<typeof roomNightSchema>;
export type RoomNightDoc = HydratedDocument<RoomNightAttrs>;
export const RoomNight = defineModel("RoomNight", roomNightSchema);
