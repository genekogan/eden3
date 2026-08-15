"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/api";
import type { AppNotificationDto } from "@/lib/types";
import {
  applyLatestNotificationLoad,
  dismissNotification,
  markEveryNotificationRead,
  markNotificationRead,
  NotificationLoadFence,
  notificationCopy,
} from "./notification-model";

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  );
}

export function NotificationCenter({
  accountKey,
  collapsed = false,
}: {
  accountKey: string | null;
  collapsed?: boolean;
}) {
  const [state, setState] = useState<{ items: AppNotificationDto[]; unreadCount: number }>({
    items: [],
    unreadCount: 0,
  });
  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<{ bottom: number; left: number } | null>(
    null,
  );
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const loadFence = useRef(new NotificationLoadFence());

  const refresh = useCallback(async (accountGeneration: number) => {
    const token = loadFence.current.beginRequest(accountGeneration);
    if (!token) return;
    try {
      await applyLatestNotificationLoad(
        loadFence.current,
        token,
        () => api.notifications.list(),
        setState,
      );
    } catch {
      // The center stays quiet while signed out or during a degraded API boot.
    }
  }, []);

  useEffect(() => {
    const accountGeneration = loadFence.current.beginAccount();
    setOpen(false);
    setState({ items: [], unreadCount: 0 });
    if (!accountKey) {
      return;
    }
    void refresh(accountGeneration);
    const unsubscribe = api.notifications.subscribe(() => void refresh(accountGeneration));
    return () => {
      loadFence.current.invalidateAccount(accountGeneration);
      unsubscribe();
    };
  }, [accountKey, refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
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

  useEffect(() => {
    if (!open) {
      setPanelPosition(null);
      return;
    }

    const positionPanel = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const gutter = 8;
      const panelWidth = Math.min(336, window.innerWidth - gutter * 2);
      setPanelPosition({
        bottom: Math.max(gutter, window.innerHeight - rect.top + gutter),
        left: Math.max(
          gutter,
          Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - gutter),
        ),
      });
    };

    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open]);

  const markRead = (id: string) => {
    setState((current) => markNotificationRead(current, id, new Date().toISOString()));
    void api.notifications
      .markRead(id)
      .then(() => void refresh(loadFence.current.currentAccount()))
      .catch(() => void refresh(loadFence.current.currentAccount()));
  };

  const markAllRead = () => {
    setState((current) => markEveryNotificationRead(current, new Date().toISOString()));
    void api.notifications
      .markAllRead()
      .then(() => void refresh(loadFence.current.currentAccount()))
      .catch(() => void refresh(loadFence.current.currentAccount()));
  };

  const dismiss = (id: string) => {
    setState((current) => dismissNotification(current, id));
    void api.notifications
      .dismiss(id)
      .then(() => void refresh(loadFence.current.currentAccount()))
      .catch(() => void refresh(loadFence.current.currentAccount()));
  };

  const panelContent = open && panelPosition ? (
    <section
          ref={panel}
          aria-label="Notifications"
          // Paint an explicit opaque surface instead of relying only on the
          // utility class. This popover sits above the conversation rail; any
          // inherited/transient opacity makes the rail's titles look like
          // duplicated notification copy.
          style={{
            backgroundColor: "var(--color-raised)",
            bottom: panelPosition.bottom,
            isolation: "isolate",
            left: panelPosition.left,
          }}
          className="fixed z-[1000] flex max-h-[calc(100vh-4rem)] w-[min(21rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-edge bg-raised opacity-100 shadow-xl shadow-black/30"
        >
          <header className="relative z-[1] flex shrink-0 items-center justify-between border-b border-edge bg-raised px-3 py-2.5">
            <h2 className="text-sm font-medium">Notifications</h2>
            {state.unreadCount > 0 ? (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs text-accent-soft hover:text-accent"
              >
                Mark all read
              </button>
            ) : null}
          </header>
          {state.items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-faint">You’re all caught up.</p>
          ) : (
            <ul className="relative z-[1] min-h-0 divide-y divide-edge/50 overflow-y-auto bg-raised px-1.5">
              {state.items.map((item) => (
                <li
                  key={item.id}
                  className="group flex min-h-12 items-start gap-2 px-2 py-2.5 transition-colors hover:bg-foreground/[0.035]"
                >
                  {item.readAt === null ? (
                    <span
                      aria-label="Unread"
                      className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent"
                    />
                  ) : null}
                  <Link
                    href={item.targetPath ?? "/agents"}
                    onClick={() => {
                      markRead(item.id);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1"
                  >
                    <span className="block truncate text-[13px] text-foreground">
                      {notificationCopy(item)}
                    </span>
                    <span className="block text-[11px] text-faint">
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </Link>
                  <button
                    type="button"
                    aria-label={`Dismiss ${notificationCopy(item)}`}
                    onClick={() => dismiss(item.id)}
                    className="px-1 text-sm text-faint opacity-70 hover:text-foreground group-hover:opacity-100"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
    </section>
  ) : null;

  return (
    <div ref={root} className="relative shrink-0">
      {panelContent ? createPortal(panelContent, document.body) : null}
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Notifications${state.unreadCount ? `, ${state.unreadCount} unread` : ""}`}
        aria-expanded={open}
        className={`relative flex size-10 items-center justify-center rounded-lg text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 ${
          collapsed ? "mx-auto" : ""
        }`}
      >
        <BellIcon />
        {state.unreadCount > 0 ? (
          <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-4 text-background">
            {state.unreadCount > 99 ? "99+" : state.unreadCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}
