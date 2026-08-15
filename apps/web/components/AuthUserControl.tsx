"use client";

import { useState } from "react";
import {
  emitDevUserChange,
  emitMannaUpdate,
} from "@/lib/api";
import { loadClerk, selectAuthMode } from "@/lib/clerk";

export function AuthUserControl({
  variant = "footer",
}: {
  variant?: "footer" | "panel";
} = {}) {
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      if (selectAuthMode() === "clerk") {
        const clerk = await loadClerk();
        await clerk.signOut?.();
      } else {
        await fetch("/api/dev/logout", {
          method: "POST",
          credentials: "include",
        });
        emitDevUserChange(null);
        emitMannaUpdate();
      }
    } finally {
      window.location.assign("/");
    }
  };

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={busy}
      className={`w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50 ${
        variant === "panel" ? "block" : "border-t border-edge"
      }`}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
