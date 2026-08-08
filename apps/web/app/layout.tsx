import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";
import { RouteShell } from "@/components/shell/route-shell";
import { ThemeProvider } from "@/components/theme-provider";
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
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0a" },
    { media: "(prefers-color-scheme: light)", color: "#f5f7f5" },
  ],
};

/**
 * FOUC guard: stamp html[data-theme] before first paint from the stored
 * preference (localStorage "eden3.theme"), falling back to the OS scheme.
 * components/theme-provider.tsx owns the state after hydration.
 */
const THEME_INIT = `(function(){try{var t=localStorage.getItem("eden3.theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="alternate" type="text/plain" href="/llms.txt" title="Eden for LLMs" />
        <link
          rel="alternate"
          type="text/plain"
          href="/llms-full.txt"
          title="Eden full guide for LLMs"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="bg-background font-sans text-foreground antialiased">
        <ThemeProvider>
          <ErrorBoundary>
            <RouteShell>{children}</RouteShell>
          </ErrorBoundary>
        </ThemeProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
