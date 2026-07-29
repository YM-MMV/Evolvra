import type { Metadata, Viewport } from "next";
import { AppProvider } from "@/components/app-provider";
import { AppShell } from "@/components/app-shell";
import {
  AccountErasureBootstrapGate,
  PendingAccountErasureRecovery,
} from "@/components/pending-account-erasure";
import { WebVitals } from "@/components/web-vitals";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Evolvra · Personal Command Centre", template: "%s · Evolvra" },
  description: "A calm, private operating system for meaningful goals, real progress, and personal development.",
  applicationName: "Evolvra",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Evolvra" },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/icon-192.png" },
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = { themeColor: "#030403", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <WebVitals />
        <AccountErasureBootstrapGate>
          <AppProvider>
            <PendingAccountErasureRecovery />
            <AppShell>{children}</AppShell>
          </AppProvider>
        </AccountErasureBootstrapGate>
      </body>
    </html>
  );
}
