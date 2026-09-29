"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { InlineError } from "@/components/common/states";
import { ApiError, api, errorMessage } from "@/lib/api";
import { businessTypeLabel } from "@/lib/format";
import type { BusinessType } from "@/types";

const typeOptions = Object.entries(businessTypeLabel).map(([value, label]) => ({ value, label }));

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = React.useState({ name: "", email: "", password: "", businessName: "", businessType: "hotel" as BusinessType });
  const [error, setError] = React.useState("");
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setFieldErrors({});
    try {
      await api("/auth/signup", { method: "POST", body: form });
      router.replace("/onboarding");
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.details) setFieldErrors(err.details);
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-3xl font-extrabold tracking-tight">Create your workspace</h1>
      <p className="mt-2 text-muted">Set up StayDesk in a few minutes. You’ll be the workspace owner.</p>
      <form onSubmit={submit} className="mt-8 space-y-5">
        <InlineError message={error} />
        <Field label="Business name" htmlFor="businessName" error={fieldErrors.businessName?.[0]}>
          <Input id="businessName" required value={form.businessName} onChange={set("businessName")} placeholder="Sunrise Boutique Hotel" />
        </Field>
        <Field label="Business type">
          <Select value={form.businessType} onValueChange={(v) => setForm((f) => ({ ...f, businessType: v as BusinessType }))} options={typeOptions} aria-label="Business type" />
        </Field>
        <Field label="Your name" htmlFor="name" error={fieldErrors.name?.[0]}>
          <Input id="name" required autoComplete="name" value={form.name} onChange={set("name")} />
        </Field>
        <Field label="Work email" htmlFor="email" error={fieldErrors.email?.[0]}>
          <Input id="email" type="email" required autoComplete="email" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters" error={fieldErrors.password?.[0]}>
          <Input id="password" type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set("password")} />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
