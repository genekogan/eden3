"use client";

/**
 * The shell's single source of agent truth.
 *
 * The selected agent lives in the URL (/agents/[username]/…); this provider
 * watches the pathname, loads that agent's profile (cached per username),
 * loads the viewer's own agents once, and remembers the last selection via
 * lib/last-agent so bare routes can bounce back to it. All data fetching is
 * client-side with cookie/Clerk auth — this app has no RSC auth forwarding.
 */

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  onAgentInventoryChange,
  onDevUserChange,
} from "@/lib/api";
import { loadClerk, selectAuthMode } from "@/lib/clerk";
import type { AgentDto, DevUser } from "@/lib/types";
import { clearLastAgent, getLastAgent, setLastAgent } from "@/lib/last-agent";
import {
  AgentCacheAuthority,
  authIdentityChanged,
} from "./agent-cache-authority";

/** /agents/<username>/… — excluding the static /agents/new + /agents/builder. */
const NON_AGENT_SEGMENTS = new Set(["new", "builder"]);

export function agentUsernameFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/agents\/([^/]+)/);
  if (!match?.[1]) return null;
  const username = decodeURIComponent(match[1]);
  return NON_AGENT_SEGMENTS.has(username) ? null : username;
}

export type SelectedAgentPhase = "idle" | "loading" | "ready" | "missing" | "error";
export type ViewerPhase = "loading" | "ready" | "signed_out" | "error";

interface SelectedAgentState {
  /** Username from the URL, or null outside /agents/[username]/… */
  username: string | null;
  agent: AgentDto | null;
  phase: SelectedAgentPhase;
  /** The signed-in (or impersonated) viewer; null until loaded / signed out. */
  viewer: DevUser | null;
  /** Distinguishes authoritative sign-out from unresolved/transient auth failures. */
  viewerPhase: ViewerPhase;
  /** Viewer owns the selected agent, or is an admin. False until both load. */
  canManage: boolean;
  refresh: () => void;
}

interface MyAgentsState {
  agents: AgentDto[] | null; // null = not loaded yet (or failed)
  phase: "loading" | "ready" | "error";
  refresh: () => void;
}

const SelectedAgentContext = createContext<SelectedAgentState>({
  username: null,
  agent: null,
  phase: "idle",
  viewer: null,
  viewerPhase: "loading",
  canManage: false,
  refresh: () => {},
});

const MyAgentsContext = createContext<MyAgentsState>({
  agents: null,
  phase: "loading",
  refresh: () => {},
});

export function SelectedAgentProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const urlUsername = agentUsernameFromPathname(pathname);

  // Off agent-scoped routes (/agents, /studio, /account, …) the selection
  // falls back to the REMEMBERED agent, so the sidebar keeps its selection
  // across reloads and domain hops. Read post-hydration (localStorage) to
  // keep SSR markup stable.
  const [fallbackUsername, setFallbackUsername] = useState<string | null>(null);
  useEffect(() => {
    if (urlUsername) {
      setFallbackUsername(null);
      return;
    }
    setFallbackUsername(getLastAgent());
  }, [urlUsername, pathname]);

  const username = urlUsername ?? fallbackUsername;
  // Cache lifetime is this viewer-aware provider, never the JS module. The
  // generation fence rejects responses admitted before an identity handoff.
  const agentCache = useRef(new Map<string, AgentDto>()).current;
  const cacheAuthority = useRef(new AgentCacheAuthority());

  const [agent, setAgent] = useState<AgentDto | null>(
    username ? (agentCache.get(username) ?? null) : null,
  );
  const [phase, setPhase] = useState<SelectedAgentPhase>(username ? "loading" : "idle");
  const [agentNonce, setAgentNonce] = useState(0);

  const [myAgents, setMyAgents] = useState<AgentDto[] | null>(null);
  const [myAgentsPhase, setMyAgentsPhase] = useState<"loading" | "ready" | "error">("loading");
  const [myAgentsNonce, setMyAgentsNonce] = useState(0);
  const [viewer, setViewer] = useState<DevUser | null>(null);
  const [viewerResolved, setViewerResolved] = useState(false);
  const [viewerPhase, setViewerPhase] = useState<ViewerPhase>("loading");
  const clerkIdentityRef = useRef<string | null | undefined>(undefined);
  const resolvedViewerIdentityRef = useRef<string | null | undefined>(undefined);

  const invalidateViewerCustody = useCallback(() => {
    cacheAuthority.current.invalidate(agentCache);
    setAgent(null);
    setPhase((current) => (current === "idle" ? "idle" : "loading"));
    setMyAgents(null);
    setMyAgentsPhase("loading");
    setViewer(null);
    setViewerResolved(false);
    setViewerPhase("loading");
    setAgentNonce((nonce) => nonce + 1);
    setMyAgentsNonce((nonce) => nonce + 1);
  }, [agentCache]);

  // Clerk's listener is the earliest authoritative A -> B / sign-out seam.
  // Clear every private cache before the replacement viewer is fetched; the
  // surrounding sign-in gate alone cannot unmount this long-lived provider.
  useEffect(() => {
    if (selectAuthMode() !== "clerk") return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void loadClerk().then((clerk) => {
      if (cancelled) return;
      const apply = () => {
        const identity = clerk.isSignedIn ? (clerk.user?.id ?? null) : null;
        const previous = clerkIdentityRef.current;
        clerkIdentityRef.current = identity;
        // Clerk subjects and Eden account UUIDs are distinct namespaces. The
        // first Clerk observation fences any /auth/me request admitted before
        // the listener attached; later subject changes fence subsequent work.
        if (previous === undefined || authIdentityChanged(previous, identity)) {
          invalidateViewerCustody();
        }
      };
      apply();
      unsubscribe = clerk.addListener?.(apply);
    }).catch(() => {
      if (!cancelled && clerkIdentityRef.current !== undefined) invalidateViewerCustody();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [invalidateViewerCustody]);

  // Clerk copies Google/OAuth profile photos into user.imageUrl. Import that
  // first-party identity image once per shell boot; the API preserves any
  // explicit Eden /media upload as the higher-priority profile choice.
  useEffect(() => {
    if (selectAuthMode() !== "clerk") return;
    let cancelled = false;
    void loadClerk()
      .then(async (clerk) => {
        const imageUrl = clerk.user?.imageUrl;
        if (!imageUrl) return;
        if (!cancelled) await api.account.syncIdentityAvatar(imageUrl);
      })
      .catch(() => {
        // Identity-photo sync is best effort and must never block sign-in.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Dev impersonation can change after this provider's initial auth read.
  // Refresh viewer authority and the owned-agent inventory immediately so
  // global surfaces such as command search do not retain the signed-out view.
  useEffect(() => {
    return onDevUserChange((user) => {
      invalidateViewerCustody();
      resolvedViewerIdentityRef.current = user?.id ?? null;
      setViewer(user);
      setViewerResolved(true);
      setViewerPhase(user ? "ready" : "signed_out");
    });
  }, [invalidateViewerCustody]);

  // Agent creation/import/profile/avatar mutations happen in several screens.
  // One app-wide invalidation keeps this long-lived shell inventory coherent
  // without coupling every mutation form back to the provider.
  useEffect(() => {
    return onAgentInventoryChange(() => {
      setMyAgentsPhase("loading");
      setMyAgentsNonce((nonce) => nonce + 1);
    });
  }, []);

  // ---- viewer (dev-impersonated or Clerk-backed) --------------------------
  useEffect(() => {
    let cancelled = false;
    const authority = cacheAuthority.current.token();
    void api.dev
      .me()
      .then((user) => {
        if (!cancelled && cacheAuthority.current.admits(authority)) {
          const identity = user?.id ?? null;
          const previous = resolvedViewerIdentityRef.current;
          resolvedViewerIdentityRef.current = identity;
          if (authIdentityChanged(previous, identity)) {
            cacheAuthority.current.invalidate(agentCache);
            setAgent(null);
            setPhase((current) => (current === "idle" ? "idle" : "loading"));
            setMyAgents(null);
            setMyAgentsPhase("loading");
            setAgentNonce((nonce) => nonce + 1);
          }
          setViewer(user);
          setViewerResolved(true);
          setViewerPhase(user ? "ready" : "signed_out");
        }
      })
      .catch(() => {
        if (!cancelled && cacheAuthority.current.admits(authority)) {
          // A transport/API failure is not evidence of sign-out, but it also
          // cannot authorize browser-resident private rows. Derived context
          // values fail closed until a fresh viewer check succeeds.
          setViewerPhase("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [myAgentsNonce]);

  // ---- selected agent (URL-driven) ----------------------------------------
  useEffect(() => {
    if (!username) {
      setAgent(null);
      setPhase("idle");
      return;
    }
    let cancelled = false;
    const authority = cacheAuthority.current.token();
    const cached = agentCache.get(username);
    if (cached) {
      setAgent(cached);
      setPhase("ready");
      setLastAgent(cached.username);
    } else {
      setAgent(null);
      setPhase("loading");
    }
    // Always revalidate (cheap GET; cached render stays visible meanwhile).
    void (async () => {
      try {
        const profile = await api.agents.get(username);
        if (cancelled || !cacheAuthority.current.admits(authority)) return;
        agentCache.set(username, profile.agent);
        setAgent(profile.agent);
        setPhase("ready");
        setLastAgent(profile.agent.username);
      } catch (err) {
        if (cancelled || !cacheAuthority.current.admits(authority)) return;
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status: unknown }).status)
            : null;
        if (status === 401 || status === 403) {
          agentCache.delete(username);
          setAgent(null);
          setPhase("error");
          return;
        }
        if (status === 404) {
          agentCache.delete(username);
          setAgent(null);
          if (urlUsername) {
            setPhase("missing");
            return;
          }
          // The remembered agent is gone (deleted/renamed) — forget it so it
          // stops resurrecting on every page, and fall back to no selection.
          clearLastAgent();
          setFallbackUsername(null);
          return;
        }
        if (!agentCache.has(username)) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username, urlUsername, agentNonce]);

  // ---- my agents (once per session, refreshable) --------------------------
  useEffect(() => {
    if (!viewerResolved) return;
    if (viewerPhase !== "ready") {
      setMyAgents(viewerPhase === "signed_out" ? [] : null);
      setMyAgentsPhase(viewerPhase === "error" ? "error" : viewerPhase === "signed_out" ? "ready" : "loading");
      return;
    }
    if (viewer === null) {
      setMyAgents([]);
      setMyAgentsPhase("ready");
      return;
    }
    let cancelled = false;
    const authority = cacheAuthority.current.token();
    void (async () => {
      try {
        const page = await api.agents.list({ scope: "mine" });
        if (cancelled || !cacheAuthority.current.admits(authority)) return;
        setMyAgents(page.items);
        setMyAgentsPhase("ready");
      } catch {
        if (cancelled || !cacheAuthority.current.admits(authority)) return;
        setMyAgents(null);
        setMyAgentsPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [myAgentsNonce, viewer, viewerResolved, viewerPhase]);

  const refreshAgent = useCallback(() => {
    if (username) agentCache.delete(username);
    setAgentNonce((n) => n + 1);
  }, [username]);
  const refreshMyAgents = useCallback(() => {
    setMyAgentsPhase("loading");
    setMyAgentsNonce((n) => n + 1);
  }, []);

  const privateAuthorityReady = viewerPhase === "ready";
  const visibleViewer = privateAuthorityReady ? viewer : null;
  const visibleAgent = privateAuthorityReady ? agent : null;
  const visibleAgentPhase = privateAuthorityReady
    ? phase
    : viewerPhase === "error" ? "error" : username ? "loading" : "idle";
  const visibleMyAgents = privateAuthorityReady ? myAgents : null;
  const visibleMyAgentsPhase = privateAuthorityReady
    ? myAgentsPhase
    : viewerPhase === "error" ? "error" : "loading";
  const canManage =
    visibleViewer !== null &&
    visibleAgent !== null &&
    ((visibleAgent.ownerId !== null && visibleAgent.ownerId === visibleViewer.id) || Boolean(visibleViewer.isAdmin));

  const selected = useMemo<SelectedAgentState>(
    () => ({ username, agent: visibleAgent, phase: visibleAgentPhase, viewer: visibleViewer, viewerPhase, canManage, refresh: refreshAgent }),
    [username, visibleAgent, visibleAgentPhase, visibleViewer, viewerPhase, canManage, refreshAgent],
  );
  const mine = useMemo<MyAgentsState>(
    () => ({ agents: visibleMyAgents, phase: visibleMyAgentsPhase, refresh: refreshMyAgents }),
    [visibleMyAgents, visibleMyAgentsPhase, refreshMyAgents],
  );

  return (
    <SelectedAgentContext.Provider value={selected}>
      <MyAgentsContext.Provider value={mine}>{children}</MyAgentsContext.Provider>
    </SelectedAgentContext.Provider>
  );
}

export function useSelectedAgent(): SelectedAgentState {
  return useContext(SelectedAgentContext);
}

export function useMyAgents(): MyAgentsState {
  return useContext(MyAgentsContext);
}

/** The current /agents/[username]/<sub> path suffix (e.g. "chats"), or null. */
export function agentSubPathFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/agents\/[^/]+\/(.+)$/);
  return match?.[1] ?? null;
}
