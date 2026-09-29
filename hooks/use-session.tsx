"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Logo } from "@/components/common/logo";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import type { Session } from "@/types";

interface SessionCtx {
  session: Session;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  canManage: boolean;
}
const Ctx = React.createContext<SessionCtx | null>(null);

export function useSession() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

/** Loads the signed-in user + business, and sends people to onboarding until it's done. */
export function SessionProvider({ children, requireOnboarded = true }: { children: React.ReactNode; requireOnboarded?: boolean }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = React.useCallback(async () => {
    setSession(await api<Session>("/auth/me"));
  }, []);

  // Resolves to a session, a redirect (401 -> /login, handled by api()), or a visible error. Never stays "loading".
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    api<Session>("/auth/me")
      .then((s) => !cancelled && setSession(s))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  React.useEffect(() => {
    if (session && requireOnboarded && !session.business.onboardingComplete && pathname !== "/onboarding") router.replace("/onboarding");
  }, [session, requireOnboarded, pathname, router]);

  const logout = React.useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }, [router]);

  if (!session && error) {
    return (
      <div className="grid min-h-dvh place-items-center px-5">
        <div role="alert" className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
          <Logo className="mb-6" />
          <h1 className="text-xl font-bold">Unable to load StayDesk</h1>
          <p className="mt-2 text-sm text-muted">We couldn’t reach the service. Please try again in a moment.</p>
          {process.env.NODE_ENV !== "production" && <p className="mt-4 rounded-xl bg-danger-soft px-3 py-2 text-left text-xs text-danger">Development detail: {error}</p>}
          <Button className="mt-6" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>Retry</Button>
        </div>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="size-8 animate-spin rounded-full border-[3px] border-brand-200 border-t-brand-600" role="status" aria-label="Loading" />
      </div>
    );
  }
  return <Ctx.Provider value={{ session, refresh, logout, canManage: session.user.role !== "staff" }}>{children}</Ctx.Provider>;
}
