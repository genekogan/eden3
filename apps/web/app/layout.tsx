import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { DevUserGate } from "@/components/DevUserGate";
import { ErrorBoundary } from "@/components/error-boundary";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";
import "./globals.css";
import "./pwa.css";

export const metadata: Metadata = {
  title: { default: "Eden", template: "%s · Eden" },
  description:
    "Eden — chat with creative agents, generate media, explore creations.",
  applicationName: "Eden",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Eden",
  },
  formatDetection: { telephone: false },
  icons: {
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0b",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background font-sans text-foreground antialiased">
        <div className="pwa-safe-area-shell flex min-h-dvh">
          <Sidebar />
          <main className="relative min-w-0 flex-1 pt-14 sm:pt-0">
            <ErrorBoundary>
              <DevUserGate>{children}</DevUserGate>
            </ErrorBoundary>
          </main>
        </div>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
