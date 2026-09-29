"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { InlineError } from "@/components/common/states";
import { api, errorMessage } from "@/lib/api";

const showDemo = process.env.NEXT_PUBLIC_SHOW_DEMO_LOGIN !== "false";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", { method: "POST", body: { email, password } });
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/overview");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-3xl font-extrabold tracking-tight">Welcome back</h1>
      <p className="mt-2 text-muted">Sign in to see your calls, follow-ups and opportunities.</p>
      <form onSubmit={submit} className="mt-8 space-y-5">
        <InlineError message={error} />
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
      {showDemo && (
        <button
          type="button"
          onClick={() => {
            setEmail("owner@sunrisehotel.demo");
            setPassword("Demo1234!");
          }}
          className="mt-4 w-full rounded-xl border border-dashed border-brand-300 bg-brand-50 px-4 py-3 text-sm text-brand-800 transition hover:bg-brand-100"
        >
          <span className="font-semibold">Try the demo:</span> Sunrise Boutique Hotel (sample data). Click to fill credentials.
        </button>
      )}
      <p className="mt-8 text-center text-sm text-muted">
        New to StayDesk?{" "}
        <Link href="/signup" className="font-semibold text-brand-700 hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
