import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "StayDesk", template: "%s · StayDesk" },
  description: "Human first. StayDesk AI answers when your team can't, so important calls never go to voicemail.",
};

export const viewport: Viewport = { themeColor: "#7654c9", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
