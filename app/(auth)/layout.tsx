import { AudioWaveform, PhoneIncoming, ShieldCheck, Sparkles } from "lucide-react";
import { Logo } from "@/components/common/logo";

const points = [
  { icon: PhoneIncoming, title: "Human first", text: "Your team answers when they can. StayDesk steps in only when they can’t." },
  { icon: Sparkles, title: "Never lose a lead", text: "Bookings, requests and callbacks are captured and waiting on your dashboard." },
  { icon: ShieldCheck, title: "Only verified answers", text: "The agent speaks only from the business information you approve." },
];

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-brand-800 via-brand-900 to-brand-950 p-14 text-white lg:flex lg:flex-col">
        <div className="absolute -top-24 -right-24 size-96 rounded-full bg-brand-500/20 blur-3xl" />
        <Logo dark />
        <div className="relative mt-auto mb-auto max-w-lg">
          <p className="mb-4 text-[11px] font-bold tracking-[0.2em] text-brand-300 uppercase">Your business, always within reach</p>
          <h2 className="text-5xl leading-[1.05] font-extrabold tracking-tight">Every call counts.</h2>
          <p className="mt-5 text-lg text-brand-200">Good conversations. Clear next steps. A little less on your plate.</p>
          <ul className="mt-10 space-y-6">
            {points.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15">
                  <Icon className="size-5 text-brand-200" />
                </span>
                <div>
                  <p className="font-semibold">{title}</p>
                  <p className="text-sm text-brand-200">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <AudioWaveform className="absolute right-10 bottom-10 size-24 text-white/5" />
      </aside>
      <main className="flex items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-md">
          <Logo className="mb-10 lg:hidden" />
          {children}
        </div>
      </main>
    </div>
  );
}
