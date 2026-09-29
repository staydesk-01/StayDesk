import { NextResponse, type NextRequest } from "next/server";

const AUTH_COOKIE = "sd_token";
const PUBLIC = ["/login", "/signup"];

/**
 * Optimistic gate only: it checks that a session cookie exists so signed-out visitors are redirected fast.
 * Real authorization happens in the Express API on every request (the token is verified there).
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has(AUTH_COOKIE);
  const isPublic = PUBLIC.some((p) => pathname === p);

  if (!hasSession && !isPublic) {
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (hasSession && isPublic) return NextResponse.redirect(new URL("/overview", req.url));
  if (pathname === "/") return NextResponse.redirect(new URL("/overview", req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
