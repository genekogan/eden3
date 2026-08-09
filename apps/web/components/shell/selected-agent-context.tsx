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
  useState,
  type ReactNode,
} from "react";
import { api, onDevUserChange } from "@/lib/api";
import type { AgentDto, DevUser } from "@/lib/types";
import { clearLastAgent, getLastAgent, setLastAgent } from "@/lib/last-agent";

/** /agents/<username>/… — excluding the static /agents/new + /agents/builder. */
const NON_AGENT_SEGMENTS = new Set(["new", "builder"]);

export function agentUsernameFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/agents\/([^/]+)/);
  if (!match?.[1]) return null;
  const username = decodeURIComponent(match[1]);
  return NON_AGENT_SEGMENTS.has(username) ? null : username;
}

export type SelectedAgentPhase = "idle" | "loading" | "ready" | "missing" | "error";

interface SelectedAgentState {
  /** Username from the URL, or null outside /agents/[username]/… */
  username: string | null;
  agent: AgentDto | null;
  phase: SelectedAgentPhase;
  /** The signed-in (or impersonated) viewer; null until loaded / signed out. */
  viewer: DevUser | null;
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
  canManage: false,
  refresh: () => {},
});

const MyAgentsContext = createContext<MyAgentsState>({
  agents: null,
  phase: "loading",
  refresh: () => {},
});

/** Session-lived profile cache — agent switches feel instant. */
const agentCache = new Map<string, AgentDto>();

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

  const [agent, setAgent] = useState<AgentDto | null>(
    username ? (agentCache.get(username) ?? null) : null,
  );
  const [phase, setPhase] = useState<SelectedAgentPhase>(username ? "loading" : "idle");
  const [agentNonce, setAgentNonce] = useState(0);

  const [myAgents, setMyAgents] = useState<AgentDto[] | null>(null);
  const [myAgentsPhase, setMyAgentsPhase] = useState<"loading" | "ready" | "error">("loading");
  const [myAgentsNonce, setMyAgentsNonce] = useState(0);
  const [viewer, setViewer] = useState<DevUser | null>(null);

  // Dev impersonation can change after this provider's initial auth read.
  // Refresh viewer authority and the owned-agent inventory immediately so
  // global surfaces such as command search do not retain the signed-out view.
  useEffect(() => {
    return onDevUserChange((user) => {
      setViewer(user);
      setMyAgentsPhase("loading");
      setMyAgentsNonce((nonce) => nonce + 1);
    });
  }, []);

  // ---- viewer (dev-impersonated or Clerk-backed) --------------------------
  useEffect(() => {
    let cancelled = false;
    void api.dev
      .me()
      .then((user) => {
        if (!cancelled) setViewer(user);
      })
      .catch(() => {
        if (!cancelled) setViewer(null);
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
        if (cancelled) return;
        agentCache.set(username, profile.agent);
        setAgent(profile.agent);
        setPhase("ready");
        setLastAgent(profile.agent.username);
      } catch (err) {
        if (cancelled) return;
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status: unknown }).status)
            : null;
        if (status === 404 && !urlUsername) {
          // The remembered agent is gone (deleted/renamed) — forget it so it
          // stops resurrecting on every page, and fall back to no selection.
          clearLastAgent();
          setFallbackUsername(null);
          return;
        }
        if (!agentCache.has(username)) {
          setPhase(status === 404 ? "missing" : "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username, urlUsername, agentNonce]);

  // ---- my agents (once per session, refreshable) --------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await api.agents.list({ scope: "mine" });
        if (cancelled) return;
        setMyAgents(page.items);
        setMyAgentsPhase("ready");
      } catch {
        if (cancelled) return;
        setMyAgents(null);
        setMyAgentsPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [myAgentsNonce]);

  const refreshAgent = useCallback(() => {
    if (username) agentCache.delete(username);
    setAgentNonce((n) => n + 1);
  }, [username]);
  const refreshMyAgents = useCallback(() => {
    setMyAgentsPhase("loading");
    setMyAgentsNonce((n) => n + 1);
  }, []);

  const canManage =
    viewer !== null &&
    agent !== null &&
    ((agent.ownerId !== null && agent.ownerId === viewer.id) || Boolean(viewer.isAdmin));

  const selected = useMemo<SelectedAgentState>(
    () => ({ username, agent, phase, viewer, canManage, refresh: refreshAgent }),
    [username, agent, phase, viewer, canManage, refreshAgent],
  );
  const mine = useMemo<MyAgentsState>(
    () => ({ agents: myAgents, phase: myAgentsPhase, refresh: refreshMyAgents }),
    [myAgents, myAgentsPhase, refreshMyAgents],
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
