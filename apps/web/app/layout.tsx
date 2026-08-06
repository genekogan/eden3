import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { DevUserGate } from "@/components/DevUserGate";
import { ErrorBoundary } from "@/components/error-boundary";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Eden", template: "%s · Eden" },
  description:
    "Eden — chat with creative agents, generate media, explore creations.",
};

export const viewport: Viewport = {
  themeColor: "#0a0b0a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background font-sans text-foreground antialiased">
        <AppShell>
          <ErrorBoundary>
            <DevUserGate>{children}</DevUserGate>
          </ErrorBoundary>
        </AppShell>
      </body>
    </html>
  );
}
