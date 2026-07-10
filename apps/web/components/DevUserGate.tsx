"use client";

/**
 * Impersonation gate. Eden's dev auth is cookie-based impersonation
 * (GET /api/dev/me): without a picked user most surfaces 401/render empty,
 * so instead of a wall of broken pages this swaps the content for one
 * friendly full-screen "pick a user" panel wrapping the DevUserSwitcher.
 *
 * Deliberately non-blocking while the answer is unknown:
 *   - checking            -> render children (no flash-block on fast APIs)
 *   - user found          -> children
 *   - /dev/me 501/404/5xx -> children (backend still landing — don't gate on it)
 *   - 200 null / 401/403  -> panel (definitively no user)
 *   - network error       -> panel with an "API offline" note + retry
 *
 * Unblocks instantly when any DevUserSwitcher instance impersonates
 * (lib/api's dev-user event bus).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError, isEndpointMissing, onDevUserChange } from "@/lib/api";
import { isClerkEnabled, loadClerk, type ClerkJs } from "@/lib/clerk";
import { DevUserSwitcher } from "@/components/DevUserSwitcher";

type GateState =
  | "checking" // first /dev/me in flight
  | "user" // impersonating someone — normal app
  | "anonymous" // api answered: nobody picked yet
  | "offline" // api unreachable
  | "unguarded"; // /dev/me not implemented/erroring — let pages self-report

export function DevUserGate({ children }: { children: ReactNode }) {
  if (process.env.NEXT_PUBLIC_EDEN3_DEV_IMPERSONATION === "1") {
    return <DevImpersonationGate>{children}</DevImpersonationGate>;
  }
  if (isClerkEnabled()) return <ClerkGate>{children}</ClerkGate>;
  return <DevImpersonationGate>{children}</DevImpersonationGate>;
}

function DevImpersonationGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");

  const check = useCallback(async () => {
    try {
      const me = await api.dev.me();
      setState(me ? "user" : "anonymous");
    } catch (error) {
      if (isEndpointMissing(error)) setState("unguarded");
      else if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403) {
          setState("anonymous");
        } else if (
          // In the browser an api outage surfaces as the Next rewrite's own
          // 5xx (bodyless 500 HTML / 502+), not a fetch failure — treat both
          // as offline. A real api 500 carries a JSON body -> unguarded.
          error.status >= 502 ||
          (error.status === 500 && error.body === undefined)
        ) {
          setState("offline");
        } else {
          setState("unguarded");
        }
      } else setState("offline");
    }
  }, []);

  useEffect(() => {
    void check();
    return onDevUserChange((user) => {
      if (user) setState("user");
      else void check();
    });
  }, [check]);

  if (state === "anonymous" || state === "offline") {
    return <PickUserPanel offline={state === "offline"} onRetry={check} />;
  }
  return <>{children}</>;
}

type ClerkGateState = "checking" | "user" | "anonymous" | "offline";

function ClerkGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ClerkGateState>("checking");
  const [clerk, setClerk] = useState<ClerkJs | null>(null);

  const boot = useCallback(async () => {
    setState("checking");
    try {
      const loaded = await loadClerk();
      setClerk(loaded);
      setState(loaded.isSignedIn ? "user" : "anonymous");
      return loaded;
    } catch {
      setState("offline");
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void boot().then((loaded) => {
      if (!loaded || cancelled) return;
      unsubscribe = loaded.addListener?.(() => {
        if (!cancelled) setState(loaded.isSignedIn ? "user" : "anonymous");
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [boot]);

  if (state === "anonymous" || state === "offline" || state === "checking") {
    return (
      <ClerkPanel
        clerk={clerk}
        loading={state === "checking"}
        offline={state === "offline"}
        onRetry={() => void boot()}
      />
    );
  }

  return <>{children}</>;
}

function ClerkPanel({
  clerk,
  loading,
  offline,
  onRetry,
}: {
  clerk: ClerkJs | null;
  loading: boolean;
  offline: boolean;
  onRetry: () => void;
}) {
  const signInRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = signInRef.current;
    if (!el || !clerk || loading || offline) return;
    clerk.mountSignIn(el);
    return () => {
      clerk.unmountSignIn?.(el);
      el.innerHTML = "";
    };
  }, [clerk, loading, offline]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3">
          <span aria-hidden className="size-2.5 rounded-full bg-accent" />
          <span className="font-mono text-xs tracking-[0.35em] text-muted">
            EDEN<span className="text-accent">3</span>
          </span>
        </div>

        <h1 className="mt-8 text-2xl font-light tracking-tight text-foreground">
          Sign in
        </h1>
        {offline ? (
          <>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Clerk is not reachable from this browser session.
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-5 rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Retry connection
            </button>
          </>
        ) : loading ? (
          <p className="mt-3 text-sm text-muted">Loading…</p>
        ) : (
          <div ref={signInRef} className="mt-6" />
        )}
      </div>
    </div>
  );
}

function PickUserPanel({
  offline,
  onRetry,
}: {
  offline: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3">
          <span aria-hidden className="size-2.5 rounded-full bg-accent" />
          <span className="font-mono text-xs tracking-[0.35em] text-muted">
            EDEN<span className="text-accent">3</span>
          </span>
        </div>

        <h1 className="mt-8 text-2xl font-light tracking-tight text-foreground">
          Pick a user
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {offline
            ? "The Eden API isn't reachable — start @eden3/api on :4301, then choose an account."
            : "Eden runs on impersonation auth in dev. Choose an account to browse as — sessions, manna, and creations are all scoped to it."}
        </p>

        <div className="mt-8 rounded-xl border border-edge bg-surface p-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-faint">
            dev impersonation
          </p>
          <DevUserSwitcher variant="panel" />
        </div>

        {offline ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            Retry connection
          </button>
        ) : null}
      </div>
    </div>
  );
}
