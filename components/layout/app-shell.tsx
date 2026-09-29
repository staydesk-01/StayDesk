"use client";
import * as React from "react";
import { usePathname } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronRight, Menu } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { BackendStatus } from "./backend-status";
import { NotificationBell } from "./notification-bell";
import { Sidebar } from "./sidebar";

const titles: Record<string, string> = {
  "/overview": "Overview",
  "/calls": "Call activity",
  "/follow-ups": "Follow-ups",
  "/opportunities": "Opportunities",
  "/business-knowledge": "Business knowledge",
  "/call-routing": "Call routing",
  "/test-agent": "Test your agent",
  "/settings": "Settings",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const { session } = useSession();
  const base = "/" + pathname.split("/")[1];
  const title = titles[base] ?? "StayDesk";
  const initials = session.user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="min-h-dvh lg:pl-[310px]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[310px] border-r border-border bg-background lg:block">
        <Sidebar />
      </aside>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-brand-950/40 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-[300px] max-w-[85vw] bg-background shadow-2xl outline-none lg:hidden" aria-describedby={undefined}>
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <Sidebar onNavigate={() => setOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <header className="sticky top-0 z-20 flex h-[72px] items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur sm:px-8 lg:h-[100px] lg:px-14">
        <button className="grid size-10 place-items-center rounded-xl text-muted hover:bg-brand-50 lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
          <Menu className="size-5" />
        </button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2.5 text-[15px]">
          <span className="hidden text-muted sm:inline">Workspace</span>
          <ChevronRight className="hidden size-4 text-subtle sm:inline" />
          <span className="truncate font-semibold text-foreground">{title}</span>
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-4">
          <span className="hidden text-[15px] text-muted md:inline">{new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
          <span className="hidden h-6 w-px bg-border md:block" />
          <span className="hidden items-center gap-2 text-sm text-muted sm:inline-flex">
            <span className="size-2 rounded-full bg-brand-500" />
            {session.business.isDemo ? "Demo workspace" : "MVP workspace"}
          </span>
          <NotificationBell />
          <span className="grid size-10 place-items-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">{initials}</span>
        </div>
      </header>

      <BackendStatus />
      <main className="mx-auto w-full max-w-[1500px] px-4 py-8 sm:px-8 lg:px-14 lg:py-12">{children}</main>
    </div>
  );
}
