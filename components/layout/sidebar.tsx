"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChevronsUpDown, LayoutGrid, ListChecks, LogOut, PhoneCall, PhoneForwarded, RadioTower, Settings, ShieldCheck, Target, AudioWaveform } from "lucide-react";
import { Logo } from "@/components/common/logo";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils";

const groups = [
  {
    label: "Workspace",
    items: [
      { href: "/overview", label: "Overview", icon: LayoutGrid },
      { href: "/calls", label: "Call activity", icon: PhoneCall },
      { href: "/follow-ups", label: "Follow-ups", icon: ListChecks, badge: "followups" as const },
      { href: "/opportunities", label: "Opportunities", icon: Target },
    ],
  },
  {
    label: "",
    items: [
      { href: "/business-knowledge", label: "Business knowledge", icon: BookOpen },
      { href: "/call-routing", label: "Call routing", icon: PhoneForwarded },
      { href: "/telephony", label: "Telephony", icon: RadioTower },
      { href: "/test-agent", label: "Test your agent", icon: AudioWaveform, tag: "TRY" },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { session, logout } = useSession();
  const { data } = useApi<{ counts: Record<string, number> }>("/follow-ups?status=active&limit=1", { events: ["followup.updated", "call.updated"], refreshMs: 60_000 });
  const openFollowUps = (data?.counts.open ?? 0) + (data?.counts.in_progress ?? 0);
  const initials = session.user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const bizInitials = session.business.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="flex h-full flex-col gap-6 px-5 py-6">
      <Link href="/overview" onClick={onNavigate} aria-label="StayDesk home" className="px-1">
        <Logo />
      </Link>

      <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3.5 shadow-card">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-[13px] font-bold text-brand-800">{bizInitials}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">{session.business.name}</span>
          <span className="block truncate text-xs text-muted">Business workspace</span>
        </span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto" aria-label="Main">
        {groups.map((g, gi) => (
          <div key={gi} className={cn(gi > 0 && "mt-6 border-t border-border pt-6")}>
            {g.label && <p className="mb-3 px-3 text-[11px] font-bold tracking-[0.2em] text-muted uppercase">{g.label}</p>}
            {g.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn("mb-1 flex items-center gap-3.5 rounded-xl px-3.5 py-3 text-[15px] font-medium transition", active ? "bg-brand-100 font-semibold text-brand-800" : "text-muted hover:bg-brand-50 hover:text-foreground")}
                >
                  <Icon className={cn("size-5", active ? "text-brand-700" : "text-muted")} />
                  <span className="flex-1">{item.label}</span>
                  {"badge" in item && openFollowUps > 0 && <span className="rounded-full bg-brand-200 px-2 py-0.5 text-xs font-bold text-brand-800">{openFollowUps}</span>}
                  {"tag" in item && <span className="rounded-md bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-brand-700">{item.tag}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 text-sm text-muted">
        <span className="size-2 rounded-full bg-brand-500" />
        <span className="flex-1">{session.business.isDemo ? "Sample data" : "Live workspace"}</span>
        <ShieldCheck className="size-[18px] text-brand-600" />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-3 rounded-xl border-t border-border px-1 pt-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">{initials}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold">{session.user.name}</span>
              <span className="block truncate text-xs text-muted capitalize">Workspace {session.user.role}</span>
            </span>
            <ChevronsUpDown className="size-4 text-subtle" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuLabel>{session.user.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void logout()}>
            <LogOut className="size-4" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
