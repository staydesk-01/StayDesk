import { SessionProvider } from "@/hooks/use-session";
import { ToastProvider } from "@/components/ui/toast";

export default function OnboardingLayout({ children }: LayoutProps<"/onboarding">) {
  return (
    <SessionProvider requireOnboarded={false}>
      <ToastProvider>{children}</ToastProvider>
    </SessionProvider>
  );
}
