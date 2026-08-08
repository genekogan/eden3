"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { AccessGate } from "@/components/AccessGate";
import { DevUserGate } from "@/components/DevUserGate";
import { isPublicSharePath } from "@/lib/public-routes";
import { AppShell } from "./app-shell";

/** Public shares bypass account gates and cockpit chrome; everything else does not. */
export function RouteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isPublicSharePath(pathname)) return <>{children}</>;
  return (
    <AppShell>
      <DevUserGate>
        <AccessGate>{children}</AccessGate>
      </DevUserGate>
    </AppShell>
  );
}
