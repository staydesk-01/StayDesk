import type { Types } from "mongoose";

/** Plain, provider-neutral reservation shape. Every booking system (native, PMS, calendar) maps to/from this. */
export interface ReservationRecord {
  confirmationCode: string;
  guestName: string;
  guestPhone: string;
  roomTypeId: string;
  roomTypeName: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  nights: number;
  guests: number;
  nightlyRate: number;
  totalAmount: number;
  status: "confirmed" | "modified" | "cancelled";
}

export interface RoomOption {
  roomTypeId: string;
  name: string;
  nightlyRate: number;
  capacity: number;
  available: number;
  total: number;
}

export interface StayQuery {
  checkIn: string;
  checkOut: string;
  guests?: number;
}

export interface CreateInput extends StayQuery {
  roomTypeId: string;
  guestName: string;
  guestPhone: string;
  guestEmail?: string;
  guests: number;
  callId?: Types.ObjectId;
  isDemo?: boolean;
  source?: "ai_call" | "staff" | "test";
}

export interface ModifyInput {
  checkIn?: string;
  checkOut?: string;
  roomTypeId?: string;
  guests?: number;
}

export type BookingErrorCode = "unavailable" | "not_found" | "invalid" | "integration_unavailable";
export class BookingError extends Error {
  constructor(
    public code: BookingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BookingError";
  }
}

/**
 * A system of record for reservations. StayDesk only tells a caller something is booked after
 * `createReservation` succeeded AND `findReservation` reads the same data back.
 */
export interface BookingProvider {
  readonly id: string;
  isConfigured(businessId: Types.ObjectId): Promise<boolean>;
  listRoomTypes(businessId: Types.ObjectId): Promise<RoomOption[]>;
  checkAvailability(businessId: Types.ObjectId, q: StayQuery): Promise<RoomOption[]>;
  createReservation(businessId: Types.ObjectId, input: CreateInput): Promise<ReservationRecord>;
  findReservation(businessId: Types.ObjectId, confirmationCode: string): Promise<ReservationRecord | null>;
  modifyReservation(businessId: Types.ObjectId, confirmationCode: string, changes: ModifyInput): Promise<ReservationRecord>;
  cancelReservation(businessId: Types.ObjectId, confirmationCode: string): Promise<ReservationRecord>;
}
