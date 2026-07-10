"use client";

import { useEffect, useRef, useState } from "react";
import { isClerkEnabled, loadClerk, type ClerkJs } from "@/lib/clerk";
import { DevUserSwitcher } from "@/components/DevUserSwitcher";

export function AuthUserControl() {
  if (!isClerkEnabled()) return <DevUserSwitcher />;
  return <ClerkUserControl />;
}

function ClerkUserControl() {
  const [clerk, setClerk] = useState<ClerkJs | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void loadClerk().then(
      (loaded) => {
        if (!cancelled) setClerk(loaded);
      },
      () => {
        if (!cancelled) setClerk(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !clerk?.isSignedIn) return;
    clerk.mountUserButton(el);
    return () => {
      clerk.unmountUserButton?.(el);
      el.innerHTML = "";
    };
  }, [clerk]);

  return (
    <div className="flex min-h-14 items-center justify-center border-t border-edge p-2 lg:justify-start lg:px-3">
      <div ref={mountRef} />
    </div>
  );
}
