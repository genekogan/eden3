"use client";

/**
 * Closed-alpha access gate. When the API's ACCESS_ALLOWLIST is set, every
 * route 403s (`access_gated`) for accounts not on the list; /auth/me stays
 * reachable and reports `accessGated` so this component can swap the app for
 * one friendly closed-beta panel instead of a wall of failed fetches.
 *
 * Sits INSIDE DevUserGate, so a user identity (dev-impersonated or Clerk)
 * already exists by the time we render. Same tolerance rules as DevUserGate:
 * unknown/erroring answers never block — the gate only engages on a
 * definitive `accessGated: true`.
 */

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, onDevUserChange } from "@/lib/api";
import { loadClerk, selectAuthMode } from "@/lib/clerk";
import { purgeDictationDraftsBeforeSignOut } from "@/lib/dictation-storage";

type GateState = "checking" | "open" | "gated";

export function AccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [username, setUsername] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    // Give the atomic browser-audio purge a bounded chance to commit before
    // navigation; broken IndexedDB can delay sign-out by at most 500ms.
    await purgeDictationDraftsBeforeSignOut();
    try {
      if (selectAuthMode() === "clerk") {
        const clerk = await loadClerk();
        await clerk.signOut?.();
      } else {
        await fetch("/api/dev/logout", { method: "POST", credentials: "include" });
      }
    } finally {
      window.location.href = "/";
    }
  }, []);

  const check = useCallback(async () => {
    try {
      const me = await api.auth.me();
      setUsername(me.user?.username ?? null);
      setState(me.accessGated === true ? "gated" : "open");
    } catch {
      // API unreachable or erroring: DevUserGate/page-level handling owns
      // those states — never block on them here.
      setState("open");
    }
  }, []);

  useEffect(() => {
    void check();
    return onDevUserChange(() => void check());
  }, [check]);

  if (state !== "gated") return <>{children}</>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3">
          <span aria-hidden className="size-2.5 rounded-full bg-accent" />
          <span className="font-mono text-xs tracking-[0.35em] text-muted">
            EDEN<span className="text-accent">2</span>
          </span>
        </div>

        <h1 className="mt-8 text-2xl font-light tracking-tight text-foreground">
          Closed alpha
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {username ? (
            <>
              Hi <span className="text-foreground">{username}</span> — this
              Eden instance is invite-only while its operator tests it with a
              small group. Contact the instance operator to request access.
            </>
          ) : (
            <>
              This Eden instance is invite-only while its operator tests it
              with a small group. Contact the instance operator to request
              access.
            </>
          )}
        </p>
        <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.25em] text-faint">
          access is managed by this instance&apos;s operator
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={signingOut}
          className="mt-8 rounded-lg border border-edge bg-surface px-4 py-2 text-sm text-foreground transition-colors hover:border-strong disabled:opacity-50"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
