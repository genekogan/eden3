"use client";

import { useEffect } from "react";

export const SERVICE_WORKER_PATH = "/sw.js";

export function registerEdenServiceWorker(
  serviceWorker: Pick<ServiceWorkerContainer, "register"> | undefined,
) {
  if (!serviceWorker) return Promise.resolve(undefined);
  return serviceWorker.register(SERVICE_WORKER_PATH, {
    scope: "/",
    updateViaCache: "none",
  });
}

export function ServiceWorkerRegistration() {
  useEffect(() => {
    // Avoid persistent cache state while editing with `next dev`. Production
    // builds (including local `next start`) retain normal PWA behavior.
    if (process.env.NODE_ENV !== "production") return;
    void registerEdenServiceWorker(window.navigator.serviceWorker).catch(() => {
      // Offline support is progressive enhancement; a blocked service worker
      // must never prevent the authenticated application from starting.
    });
  }, []);

  return null;
}
