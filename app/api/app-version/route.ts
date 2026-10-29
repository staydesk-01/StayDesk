import { NextResponse } from "next/server";
import { CURRENT_BUILD } from "@/lib/app-update";

export const dynamic = "force-dynamic";

/**
 * Public, tiny and DB-free: reports the build that is currently deployed. Browsers compare `buildId` with the one
 * their page was loaded from; it changes on every deployment (commit SHA / deployment id / per-build stamp).
 */
export function GET() {
  return NextResponse.json(CURRENT_BUILD, { headers: { "cache-control": "no-store, max-age=0" } });
}
