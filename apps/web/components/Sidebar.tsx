"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthUserControl } from "@/components/AuthUserControl";
import { MannaBadge } from "@/components/manna-badge";

/** Minimal 24px stroke icons (multi-subpath `d` strings, lucide-derived). */
const ICONS = {
  newChat:
    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7.5v5M9.5 10h5",
  agents:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  explore:
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36z",
  studio:
    "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
  tasks: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M12 6v6l4 2",
  channels:
    "M6 11h12M6 13h12M8 20a4 4 0 0 1-4-4v-3a4 4 0 0 1 4-4h1V6a3 3 0 1 1 6 0v3h1a4 4 0 0 1 4 4v3a4 4 0 0 1-4 4M12 3v6",
  skills:
    "M15.5 7.5 17 6a3 3 0 1 0-4.24-4.24l-7.78 7.78a2 2 0 0 0-.59 1.42V14h3.04a2 2 0 0 0 1.42-.59l1.65-1.65M13 10l3 3M3 21h18M7 17h10",
  collections:
    "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83zM22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
  manna: "M6 3h12l4 6-10 13L2 9zM11 3 8 9l4 13 4-13-3-6M2 9h20",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19.4 15a1.7 1.7 0 0 0 .34 1.87l.04.05a2 2 0 1 1-2.83 2.83l-.05-.04a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.05.04a2 2 0 1 1-2.83-2.83l.04-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.04-.05a2 2 0 1 1 2.83-2.83l.05.04A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.05-.04a2 2 0 1 1 2.83 2.83l-.04.05A1.7 1.7 0 0 0 19.4 9c.14.6.64 1 1.55 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.52 1",
  operator:
    "M3 3v18h18M7 16v-5M12 16V7M17 16v-8M7 21v-5M12 21v-5M17 21v-5",
} as const;

function NavIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4 shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

const NAV = [
  { href: "/agents", label: "Agents", icon: ICONS.agents },
  { href: "/explore", label: "Explore", icon: ICONS.explore },
  { href: "/studio", label: "Studio", icon: ICONS.studio },
  { href: "/tasks", label: "Tasks", icon: ICONS.tasks },
  { href: "/channels", label: "Channels", icon: ICONS.channels },
  { href: "/skills", label: "Skills", icon: ICONS.skills },
  { href: "/collections", label: "Collections", icon: ICONS.collections },
  { href: "/manna", label: "Manna", icon: ICONS.manna },
  { href: "/settings", label: "Settings", icon: ICONS.settings },
  { href: "/operator", label: "Operator", icon: ICONS.operator },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  // Session permalinks are chat surfaces — light up "New Chat" for them too.
  const chatActive = isActive("/chat") || isActive("/sessions");

  return (
    // Collapses to an icon rail below lg; labels and the manna chip return at lg+.
    <aside className="sticky top-0 flex h-dvh w-14 shrink-0 flex-col border-r border-edge bg-surface lg:w-56">
      <div className="flex justify-center pb-5 pt-6 lg:justify-start lg:px-5">
        <Link
          href="/"
          aria-label="Eden home"
          title="Eden"
          className="font-mono text-sm tracking-[0.35em] text-foreground"
        >
          <span className="hidden lg:inline">
            EDEN<span className="text-accent">3</span>
          </span>
          <span
            aria-hidden
            className="mt-1 block size-2.5 rounded-full bg-accent lg:hidden"
          />
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 lg:px-3" aria-label="Primary">
        <Link
          href="/chat"
          aria-current={chatActive ? "page" : undefined}
          title="New Chat"
          className={`mb-5 flex items-center justify-center gap-0 rounded-lg border px-0 py-2 text-sm transition-colors lg:justify-start lg:gap-2.5 lg:px-3 ${
            chatActive
              ? "border-accent/60 bg-accent/15 text-accent-soft"
              : "border-accent/30 text-accent-soft hover:border-accent/60 hover:bg-accent/10"
          }`}
        >
          <NavIcon d={ICONS.newChat} />
          <span className="hidden lg:inline">New Chat</span>
        </Link>

        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  className={`relative flex items-center justify-center gap-0 rounded-lg px-0 py-2 text-sm transition-colors lg:justify-start lg:gap-2.5 lg:px-3 ${
                    active
                      ? "bg-white/[0.05] text-foreground"
                      : "text-muted hover:bg-white/[0.03] hover:text-foreground"
                  }`}
                >
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent"
                    />
                  ) : null}
                  <span className={active ? "text-accent-soft" : "text-faint"}>
                    <NavIcon d={item.icon} />
                  </span>
                  <span className="hidden lg:inline">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Rail mode keeps manna reachable via the nav icon; the live chip needs width. */}
      <div className="hidden px-3 pb-2 lg:block">
        <MannaBadge className="w-fit" />
      </div>
      <AuthUserControl />
    </aside>
  );
}
