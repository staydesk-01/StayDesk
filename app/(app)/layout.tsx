import { AppShell } from "@/components/layout/app-shell";
import { UpdateNotifier } from "@/components/layout/update-notifier";
import { SessionProvider } from "@/hooks/use-session";
import { ToastProvider } from "@/components/ui/toast";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <SessionProvider>
      <ToastProvider>
        <AppShell>{children}</AppShell>
        <UpdateNotifier />
      </ToastProvider>
    </SessionProvider>
  );
}
