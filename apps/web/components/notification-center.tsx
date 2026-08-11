"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

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
  const root = useRef<HTMLDivElement>(null);
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
      if (!root.current?.contains(event.target as Node)) setOpen(false);
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

  return (
    <div ref={root} className="relative shrink-0">
      {open ? (
        <section
          aria-label="Notifications"
          className="fixed bottom-14 left-2 z-[60] flex max-h-[calc(100vh-4rem)] w-[min(21rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-edge bg-raised shadow-xl shadow-black/30 sm:absolute sm:bottom-full sm:left-0 sm:mb-2"
        >
          <header className="flex items-center justify-between border-b border-edge px-3 py-2.5">
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
            <ul className="min-h-0 overflow-y-auto p-1.5">
              {state.items.map((item) => (
                <li
                  key={item.id}
                  className={`group flex items-start gap-2 rounded-lg px-2 py-2 ${
                    item.readAt === null ? "bg-accent/[0.08]" : ""
                  }`}
                >
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
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Notifications${state.unreadCount ? `, ${state.unreadCount} unread` : ""}`}
        aria-expanded={open}
        className={`relative flex size-10 items-center justify-center text-muted transition-colors hover:text-foreground ${
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
