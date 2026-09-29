import Link from "next/link";
import { ArrowRight, AudioWaveform } from "lucide-react";
import { Button } from "@/components/ui/button";

const bars = [22, 38, 56, 30, 64, 44, 72, 40, 58, 28, 66, 46, 34, 60, 26, 50, 36, 68, 42, 24, 54, 32, 62, 38];

export function VoiceAgentCard({ active, phoneConnected, agentName }: { active: boolean; phoneConnected: boolean; agentName: string }) {
  return (
    <div className="relative flex h-full min-h-[22rem] flex-col overflow-hidden rounded-[var(--radius-card)] bg-gradient-to-br from-brand-800 via-brand-900 to-brand-950 p-7 text-white shadow-card">
      <div className="absolute -top-16 -right-16 size-56 rounded-full bg-brand-500/25 blur-3xl" />
      <div className="relative flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15">
          <AudioWaveform className="size-5" />
        </span>
        <span className="text-[11px] font-bold tracking-[0.2em] text-brand-200 uppercase">Your voice agent</span>
      </div>
      <h3 className="relative mt-8 text-[28px] leading-tight font-bold tracking-tight">
        Ready when
        <br />
        you need a hand.
      </h3>
      <ul className="relative mt-5 space-y-1 text-sm text-brand-200">
        <li>Answer the everyday questions.</li>
        <li>Capture what matters.</li>
        <li>Keep your team in the loop.</li>
      </ul>
      <div className="relative mt-5 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 font-semibold ring-1 ring-white/15">
          <span className={active && phoneConnected ? "sd-live-dot size-2 rounded-full bg-emerald-400" : "size-2 rounded-full bg-amber-300"} />
          {agentName} · {active ? (phoneConnected ? "Live on your line" : "Ready to test") : "Paused"}
        </span>
      </div>
      <div className="relative mt-auto flex items-end gap-1 pt-8" aria-hidden>
        {bars.map((h, i) => (
          <span key={i} className="w-1.5 flex-1 origin-bottom rounded-full bg-white/25" style={{ height: `${h}px`, animation: `sd-wave ${1.4 + (i % 5) * 0.25}s ease-in-out ${i * 0.06}s infinite` }} />
        ))}
      </div>
      <div className="relative mt-5 flex gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link href="/test-agent">
            Test it <ArrowRight />
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost" className="text-brand-200 hover:bg-white/10 hover:text-white">
          <Link href="/call-routing">Call routing</Link>
        </Button>
      </div>
    </div>
  );
}
