import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import manifest from "../app/manifest";
import {
  SERVICE_WORKER_PATH,
  registerEdenServiceWorker,
} from "../components/pwa/service-worker-registration";

const WEB_ROOT = resolve(import.meta.dirname, "..");

function pngDimensions(path: string) {
  const image = readFileSync(path);
  expect(image.subarray(1, 4).toString()).toBe("PNG");
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
  };
}

function loadServiceWorker() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const addAll = vi.fn().mockResolvedValue(undefined);
  const cacheMatch = vi.fn().mockResolvedValue(undefined);
  const put = vi.fn().mockResolvedValue(undefined);
  const cache = { addAll, match: cacheMatch, put };
  const cachesMatch = vi.fn().mockResolvedValue(undefined);
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    match: cachesMatch,
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
  };
  const fetch = vi.fn();
  const claim = vi.fn().mockResolvedValue(undefined);
  const self = {
    location: { origin: "https://eden.test" },
    clients: { claim },
    addEventListener: (
      name: string,
      listener: (event: Record<string, unknown>) => void,
    ) => listeners.set(name, listener),
  };

  vm.runInNewContext(
    readFileSync(resolve(WEB_ROOT, "public/sw.js"), "utf8"),
    { URL, Promise, caches, fetch, self },
  );

  return { listeners, addAll, cacheMatch, cachesMatch, fetch };
}

describe("PWA manifest", () => {
  it("declares an installable, same-origin standalone application", () => {
    const value = manifest();
    expect(value).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0a0a0b",
      theme_color: "#0a0a0b",
    });
    expect(value.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
  });

  it.each([
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ])("ships a correctly sized %s", (filename, size) => {
    expect(
      pngDimensions(resolve(WEB_ROOT, "public/icons", filename)),
    ).toEqual({ width: size, height: size });
  });

  it("wires cover viewport, safe-area styling, manifest, and registration", () => {
    const layout = readFileSync(resolve(WEB_ROOT, "app/layout.tsx"), "utf8");
    expect(layout).toContain('manifest: "/manifest.webmanifest"');
    expect(layout).toContain('viewportFit: "cover"');
    expect(layout).toContain("pwa-safe-area-shell");
    expect(layout).toContain("<ServiceWorkerRegistration />");
  });
});

describe("service worker", () => {
  it("registers at the application root without HTTP cache reuse", async () => {
    const register = vi.fn().mockResolvedValue({ scope: "/" });
    await registerEdenServiceWorker({ register } as never);
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_PATH, {
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("pre-caches the offline shell and install icons", async () => {
    const { listeners, addAll } = loadServiceWorker();
    let installation: Promise<unknown> | undefined;
    listeners.get("install")?.({
      waitUntil: (promise: Promise<unknown>) => {
        installation = promise;
      },
    });
    await installation;

    expect(addAll).toHaveBeenCalledWith(
      expect.arrayContaining([
        "/offline.html",
        "/icons/icon-192.png",
        "/icons/icon-maskable-512.png",
      ]),
    );
  });

  it("falls back to the offline page only for failed navigations", async () => {
    const { listeners, cachesMatch, fetch } = loadServiceWorker();
    const offlineResponse = new Response("offline");
    fetch.mockRejectedValueOnce(new TypeError("network unavailable"));
    cachesMatch.mockResolvedValueOnce(offlineResponse);

    let response: Promise<Response | undefined> | undefined;
    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://eden.test/sessions",
      },
      respondWith: (promise: Promise<Response | undefined>) => {
        response = promise;
      },
    });

    expect(await response).toBe(offlineResponse);
    expect(cachesMatch).toHaveBeenCalledWith("/offline.html");
  });

  it("does not intercept API requests or cache authenticated responses", () => {
    const { listeners, fetch } = loadServiceWorker();
    const respondWith = vi.fn();
    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "cors",
        url: "https://eden.test/api/sessions",
      },
      respondWith,
    });

    expect(respondWith).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves previously cached immutable Next assets", async () => {
    const { listeners, cacheMatch, fetch } = loadServiceWorker();
    const cachedResponse = new Response("chunk");
    cacheMatch.mockResolvedValueOnce(cachedResponse);

    let response: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "cors",
        url: "https://eden.test/_next/static/chunks/app.js",
      },
      respondWith: (promise: Promise<Response>) => {
        response = promise;
      },
    });

    expect(await response).toBe(cachedResponse);
    expect(fetch).not.toHaveBeenCalled();
  });
});
