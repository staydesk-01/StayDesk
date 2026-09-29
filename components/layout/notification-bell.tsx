"use client";
import Link from "next/link";
import { Bell, CalendarCheck, PhoneOff, TriangleAlert, Sparkles, UserPlus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useApi } from "@/hooks/use-api";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AppNotification, NotificationType } from "@/types";

const icons: Record<NotificationType, typeof Bell> = {
  high_value_lead: Sparkles,
  booking_inquiry: CalendarCheck,
  urgent_request: TriangleAlert,
  transfer_failed: PhoneOff,
  callback_requested: UserPlus,
  unresolved_request: TriangleAlert,
  service_request: CalendarCheck,
  info: Bell,
};

export function NotificationBell() {
  const { data, refetch } = useApi<{ notifications: AppNotification[]; unread: number }>("/notifications", { events: ["notification.created"], refreshMs: 30_000 });
  const unread = data?.unread ?? 0;

  async function markAll() {
    await api("/notifications/read-all", { method: "POST" });
    await refetch();
  }
  async function markOne(id: string) {
    await api(`/notifications/${id}/read`, { method: "PATCH" });
    await refetch();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="relative grid size-10 place-items-center rounded-xl text-muted transition hover:bg-brand-50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
          <Bell className="size-5" />
          {unread > 0 && <span className="absolute top-1.5 right-1.5 grid min-w-4 place-items-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">{unread > 9 ? "9+" : unread}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(26rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-bold">Notifications</p>
          {unread > 0 && (
            <button onClick={markAll} className="text-xs font-semibold text-brand-700 hover:underline">
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {!data?.notifications.length ? (
            <p className="px-4 py-10 text-center text-sm text-muted">You’re all caught up.</p>
          ) : (
            data.notifications.map((n) => {
              const Icon = icons[n.type] ?? Bell;
              return (
                <Link key={n._id} href={n.link || "/calls"} onClick={() => !n.read && markOne(n._id)} className={cn("flex gap-3 border-b border-border/60 px-4 py-3 transition last:border-0 hover:bg-brand-50", !n.read && "bg-brand-50/60")}>
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-brand-100 text-brand-700">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-snug font-semibold">{n.title}</span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{n.body}</span>}
                    <span className="mt-1 block text-xs text-subtle">{timeAgo(n.createdAt)}</span>
                  </span>
                  {!n.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />}
                </Link>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
