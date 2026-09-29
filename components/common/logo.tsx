import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  const bars = [10, 18, 26, 16, 22, 12];
  return (
    <span className={cn("grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-900 shadow-cta", className)} aria-hidden>
      <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
        {bars.map((h, i) => (
          <rect key={i} x={3 + i * 4.6} y={16 - h / 2} width="2.6" height={h} rx="1.3" fill="white" />
        ))}
      </svg>
    </span>
  );
}

export function Logo({ className, dark }: { className?: string; dark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className={cn("text-[26px] leading-none font-extrabold tracking-tight", dark ? "text-white" : "text-brand-950")}>
        staydesk<span className="text-brand-500">.</span>
      </span>
    </span>
  );
}
