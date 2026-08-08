import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { AccessGate } from "@/components/AccessGate";
import { DevUserGate } from "@/components/DevUserGate";
import { ErrorBoundary } from "@/components/error-boundary";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Eden", template: "%s · Eden" },
  description:
    "Eden — chat with creative agents, generate media, explore creations.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background font-sans text-foreground antialiased">
        <div className="flex min-h-dvh">
          <Sidebar />
          <main className="relative min-w-0 flex-1 pt-14 sm:pt-0">
            <ErrorBoundary>
              <DevUserGate>
                <AccessGate>{children}</AccessGate>
              </DevUserGate>
            </ErrorBoundary>
          </main>
        </div>
      </body>
    </html>
  );
}
