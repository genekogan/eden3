// NOTE: deliberately NOT a "use client" module. This is a plain utility
// module: client components import it for ClerkJS loading/mounting, and the
// shared api client calls getClerkToken() from BOTH environments — on the
// server it must return null, not become a client-reference proxy (calling
// one from an RSC throws, which broke /creations/:id SSR — BUG-W5-2).
export interface ClerkJs {
  isSignedIn: boolean;
  session?: {
    getToken(): Promise<string | null>;
  } | null;
  load(opts?: Record<string, unknown>): Promise<void>;
  mountSignIn(el: HTMLElement, opts?: Record<string, unknown>): void;
  unmountSignIn?(el: HTMLElement): void;
  mountUserButton(el: HTMLElement, opts?: Record<string, unknown>): void;
  unmountUserButton?(el: HTMLElement): void;
  addListener?(listener: () => void): () => void;
}

declare global {
  interface Window {
    Clerk?: ClerkJs;
    __internal_ClerkUICtor?: unknown;
    __eden3ClerkPromise?: Promise<ClerkJs>;
  }
}

export const clerkPublishableKey =
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

export function isClerkEnabled(): boolean {
  return clerkPublishableKey.length > 0;
}

export type AuthMode = "dev-impersonation" | "clerk";

/**
 * Keep every auth surface on the same mode. An explicit dev override wins
 * even when a Clerk publishable key is present (the local E2E stack has both),
 * otherwise Clerk is used only when it is actually configured.
 */
export function selectAuthMode(
  devImpersonation = process.env.NEXT_PUBLIC_EDEN3_DEV_IMPERSONATION,
  publishableKey = clerkPublishableKey,
): AuthMode {
  return devImpersonation === "1" || publishableKey.length === 0
    ? "dev-impersonation"
    : "clerk";
}

function clerkDomainFromPublishableKey(key: string): string {
  const encoded = key.split("_")[2];
  if (!encoded) throw new Error("Invalid Clerk publishable key");
  return atob(encoded).slice(0, -1);
}

function loadScript(src: string, attrs: Record<string, string> = {}): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing?.dataset.loaded === "true") return Promise.resolve();
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
        once: true,
      });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    for (const [name, value] of Object.entries(attrs)) script.setAttribute(name, value);
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
      once: true,
    });
    document.head.appendChild(script);
  });
}

export async function loadClerk(): Promise<ClerkJs> {
  if (typeof window === "undefined") throw new Error("ClerkJS is browser-only");
  if (!isClerkEnabled()) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set");
  if (window.__eden3ClerkPromise) return window.__eden3ClerkPromise;

  window.__eden3ClerkPromise = (async () => {
    const domain = clerkDomainFromPublishableKey(clerkPublishableKey);
    await loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
      "data-clerk-publishable-key": clerkPublishableKey,
    });
    if (!window.Clerk) throw new Error("ClerkJS did not initialize");
    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
    });
    return window.Clerk;
  })();

  return window.__eden3ClerkPromise;
}

export async function getClerkToken(): Promise<string | null> {
  if (typeof window === "undefined" || !isClerkEnabled()) return null;
  const clerk = window.Clerk;
  if (!clerk?.isSignedIn || !clerk.session) return null;
  return clerk.session.getToken();
}
