import { AppShell } from "@/components/layout/app-shell";
import { SessionProvider } from "@/hooks/use-session";
import { ToastProvider } from "@/components/ui/toast";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <SessionProvider>
      <ToastProvider>
        <AppShell>{children}</AppShell>
      </ToastProvider>
    </SessionProvider>
  );
}
