import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "cache-control": "no-store" };
  try {
    await dbConnect();
    await mongoose.connection.db?.admin().ping();
    return NextResponse.json({ status: "ok", service: "StayDesk AI", database: "connected" }, { headers });
  } catch {
    return NextResponse.json({ status: "error", service: "StayDesk AI", database: "disconnected" }, { status: 503, headers });
  }
}
