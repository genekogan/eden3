"use client";

/**
 * Bottom-left user area: the signed-in user's identity + manna, with a
 * popover for user-level surfaces (account, manna, usage, operator). Agent
 * things never live here — this is the USER's corner of the shell.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, onMannaUpdate } from "@/lib/api";
import type { AuthMeResponse } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { AuthUserControl } from "@/components/AuthUserControl";
import { MannaBadge } from "@/components/manna-badge";
import { NotificationCenter } from "@/components/notification-center";
import { ThemeToggle } from "@/components/theme-provider";

const LINKS: Array<{ href: string; label: string; adminOnly?: boolean }> = [
  { href: "/help", label: "Help" },
  { href: "/account", label: "Account settings" },
  { href: "/account/manna", label: "Manna" },
  { href: "/operator", label: "Operator", adminOnly: true },
];

export function UserArea({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadMe = () => {
    void api.auth
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  };

  // Refresh on the manna bus — it also fires after dev-user impersonation.
  useEffect(() => {
    loadMe();
    return onMannaUpdate(() => loadMe());
  }, []);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const user = me?.user ?? null;

  return (
    <div ref={rootRef} className="relative border-t border-edge">
      {open ? (
        <div className="absolute inset-x-2 bottom-full z-50 mb-1.5 rounded-xl border border-edge bg-raised p-1.5 shadow-xl shadow-black/30">
          <div className="px-2 py-1.5">
            <MannaBadge className="w-fit" />
          </div>
          <ul>
            {LINKS.filter((link) => !link.adminOnly || user?.isAdmin).map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="block rounded-lg px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-edge px-2 py-2">
            <ThemeToggle />
          </div>
          <div className="border-t border-edge pt-1">
            {/* Clerk user button / dev impersonation switcher */}
            <AuthUserControl variant="panel" />
          </div>
        </div>
      ) : null}

      <div className={`flex items-center ${collapsed ? "flex-col" : ""}`}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={user ? `@${user.username}` : "Account"}
          data-testid="user-area"
          className={`flex min-w-0 flex-1 items-center p-2 text-left transition-colors hover:bg-foreground/[0.03] ${
            collapsed ? "justify-center" : "gap-2.5 pr-3 py-2.5"
          }`}
        >
        <AgentAvatar
          account={user ?? undefined}
          name={user?.username ?? "?"}
          size={collapsed ? 26 : 28}
        />
        {collapsed ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-tight text-foreground">
              {user ? `@${user.username}` : "Account"}
            </span>
            <span className="block truncate text-[10px] text-faint">
              {me?.manna
                ? `${Math.floor(me.manna.balance + (me.manna.subscriptionBalance ?? 0)).toLocaleString("en-US")} manna`
                : "—"}
            </span>
          </span>
        )}
        </button>
        <NotificationCenter
          key={user?.id ?? "anonymous"}
          accountKey={user?.id ?? null}
          collapsed={collapsed}
        />
      </div>
    </div>
  );
}
