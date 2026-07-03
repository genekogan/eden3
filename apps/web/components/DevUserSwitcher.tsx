"use client";

/**
 * Dev impersonation switcher (pinned to the sidebar footer). Auth is
 * impersonation-only in the prototype (Clerk later): pick any account, the
 * api sets a cookie, every subsequent request acts as that user.
 *
 *   GET  /api/dev/me          -> current impersonated user (tolerates 501/404)
 *   GET  /api/dev/users?q=    -> account search
 *   POST /api/dev/impersonate {accountId}
 *
 * Shows the current user's avatar + username; clicking opens a searchable
 * popover (upward) of accounts to switch into.
 *
 * Variants:
 *   - "footer" (default): sidebar footer chip. Collapses to a bare avatar in
 *     the icon rail below lg; the popover then flies out to the right.
 *   - "panel": embedded in DevUserGate's full-screen picker — no border,
 *     popover opens downward, labels always visible.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  api,
  ApiError,
  emitDevUserChange,
  emitMannaUpdate,
  isEndpointMissing,
  onDevUserChange,
} from "@/lib/api";
import type { DevUser } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";

function describeError(error: unknown): string {
  if (isEndpointMissing(error)) return "Endpoint not implemented yet";
  if (error instanceof ApiError) return `API error ${error.status}`;
  return "API offline — start @eden3/api on :4301";
}

export function DevUserSwitcher({
  variant = "footer",
}: {
  variant?: "footer" | "panel";
} = {}) {
  const inPanel = variant === "panel";
  const router = useRouter();
  const [me, setMe] = useState<DevUser | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DevUser[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.dev.me());
      setOffline(false);
    } catch (error) {
      // /dev/me may 501 while the api lands, or the api may not be running.
      setMe(null);
      setOffline(isApiish(error));
    }
  }, []);

  useEffect(() => {
    void loadMe();
    // Another switcher instance (e.g. the gate panel) changed the user.
    return onDevUserChange((user) => {
      setMe(user);
      if (user) setOffline(false);
    });
  }, [loadMe]);

  // Debounced account search while the popover is open.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await api.dev.users(query);
        setResults(items);
        setNote(items.length === 0 ? "No matching users" : null);
      } catch (error) {
        setResults([]);
        setNote(describeError(error));
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  // Close on Escape / click outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const impersonate = async (user: DevUser) => {
    setBusy(true);
    setNote(null);
    try {
      await api.dev.impersonate(user.id);
      setMe(user);
      setOffline(false);
      setOpen(false);
      setQuery("");
      emitMannaUpdate(); // sidebar badge refetches for the new user
      emitDevUserChange(user); // DevUserGate unblocks / other switchers sync
      router.refresh();
    } catch (error) {
      setNote(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className={
        inPanel ? "relative" : "relative border-t border-edge p-2 lg:p-3"
      }
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center rounded-lg border border-edge bg-raised py-2 text-left text-sm transition-colors hover:border-accent/50 ${
          inPanel
            ? "gap-2.5 px-2.5"
            : "justify-center gap-0 px-0 lg:justify-start lg:gap-2.5 lg:px-2.5"
        }`}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Switch dev user"
      >
        <AgentAvatar account={me ?? undefined} name={me?.username} size={24} />
        <span
          className={`min-w-0 flex-1 ${inPanel ? "" : "hidden lg:block"}`}
        >
          <span className="block truncate text-foreground">
            {me ? me.username : offline ? "API offline" : "No user"}
          </span>
          <span className="block font-mono text-[9px] uppercase tracking-[0.2em] text-faint">
            dev user
          </span>
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`size-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""} ${inPanel ? "" : "hidden lg:block"}`}
        >
          <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
        </svg>
      </button>

      {open ? (
        <div
          className={`z-20 rounded-lg border border-edge bg-raised p-1.5 shadow-xl shadow-black/40 ${
            inPanel
              ? "absolute inset-x-0 top-full mt-2"
              : "absolute inset-x-2 bottom-full mb-2 max-lg:fixed max-lg:inset-x-auto max-lg:bottom-2 max-lg:left-16 max-lg:mb-0 max-lg:w-72 lg:inset-x-3"
          }`}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search users…"
            aria-label="Search users to impersonate"
            className="w-full rounded-md border border-edge bg-background px-2 py-1.5 text-sm placeholder:text-faint focus:border-accent/60 focus:outline-none"
          />
          {results.length > 0 ? (
            <ul role="listbox" className="mt-1 max-h-56 overflow-y-auto">
              {results.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={user.id === me?.id}
                    disabled={busy}
                    onClick={() => void impersonate(user)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-50 ${
                      user.id === me?.id
                        ? "bg-accent/10 text-foreground"
                        : "text-muted hover:bg-accent/10 hover:text-foreground"
                    }`}
                  >
                    <AgentAvatar account={user} size={20} />
                    <span className="min-w-0 flex-1 truncate">
                      {user.username}
                      {user.name ? (
                        <span className="text-faint"> · {user.name}</span>
                      ) : null}
                    </span>
                    {user.type === "agent" ? (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-faint">
                        agent
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {note ? <p className="px-2 py-1.5 text-xs text-faint">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** True for "api can't answer" failures (network, 501/404). */
function isApiish(error: unknown): boolean {
  return !(error instanceof ApiError) || isEndpointMissing(error);
}
