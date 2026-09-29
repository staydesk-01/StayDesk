"use client";
import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-semibold">{label}</p>
      <div className="flex items-center gap-2 rounded-xl border border-border-strong bg-brand-50/50 py-1.5 pr-1.5 pl-3.5">
        <code className="min-w-0 flex-1 truncate text-[13px]">{value}</code>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
