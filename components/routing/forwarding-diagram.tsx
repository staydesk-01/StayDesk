import { ArrowRight, Bot, PhoneForwarded, Phone, Smartphone } from "lucide-react";

const steps = [
  { icon: Smartphone, title: "Existing carrier number", text: "The number customers already call" },
  { icon: PhoneForwarded, title: "Busy / no-answer forwarding", text: "Set on your phone provider" },
  { icon: Phone, title: "Twilio StayDesk number", text: "Receives forwarded calls" },
  { icon: Bot, title: "AI agent", text: "Answers, captures, notifies" },
];

export function ForwardingDiagram() {
  return (
    <ol className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch" aria-label="How existing-number forwarding works">
      {steps.map((s, i) => (
        <li key={s.title} className="contents">
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card lg:flex-col lg:items-start lg:gap-2">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700"><s.icon className="size-5" /></span>
            <div>
              <p className="text-sm font-bold">{s.title}</p>
              <p className="text-xs text-muted">{s.text}</p>
            </div>
          </div>
          {i < steps.length - 1 && <ArrowRight className="mx-auto size-5 shrink-0 rotate-90 self-center text-brand-400 lg:rotate-0" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}
