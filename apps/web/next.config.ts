import type { NextConfig } from "next";

/**
 * The api (@eden3/api, Fastify) listens on :4301. The browser only ever talks
 * same-origin to the web app; these rewrites proxy it through:
 *   /api/:path*   -> http://127.0.0.1:4301/:path*      (REST + SSE)
 *   /media/:path* -> http://127.0.0.1:4301/media/:path* (locally stored new media)
 *
 * 12-factor: origin is overridable via env so nothing assumes localhost at
 * deploy time (docs/PLAN.md "Build-toward-deployment").
 */
const API_ORIGIN =
  process.env.API_ORIGIN ?? `http://127.0.0.1:${process.env.API_PORT ?? "4301"}`;

const LEGACY_MEDIA_HOSTS = (process.env.NEXT_PUBLIC_LEGACY_MEDIA_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter((host) => /^[a-z0-9.-]+$/.test(host));

const WEB_SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
] as const;

const SHARE_CAPABILITY_HEADERS = [
  {
    key: "Cache-Control",
    value: "private, no-store, no-cache, max-age=0, must-revalidate",
  },
  { key: "CDN-Cache-Control", value: "no-store" },
  { key: "Surrogate-Control", value: "no-store" },
  { key: "Pragma", value: "no-cache" },
  { key: "Expires", value: "0" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
] as const;

const nextConfig: NextConfig = {
  // @eden3/shared ships raw .ts from the workspace — compile it in-app.
  transpilePackages: ["@eden3/shared"],
  // NEVER re-compress proxied responses: gzip buffers SSE frames, which
  // freezes the chat event streams (/api/sessions/:id/events) — EventSource
  // connects but no frame ever flushes. Compression belongs at the edge.
  compress: false,
  // Parallel `next dev` instances (multi-agent workflow) stomp each other's
  // .next; point secondary instances at their own build dir to stay isolated.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  async headers() {
    return [
      {
        // API/media are reverse-proxied below and retain Fastify's stricter,
        // payload-specific policy instead of inheriting the cockpit policy.
        source: "/((?!api(?:/|$)|media(?:/|$)).*)",
        headers: [...WEB_SECURITY_HEADERS],
      },
      { source: "/share/:token/:path*", headers: [...SHARE_CAPABILITY_HEADERS] },
      {
        source: "/_next/data/:buildId/share/:token.json",
        headers: [...SHARE_CAPABILITY_HEADERS],
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/:path*` },
      { source: "/media/:path*", destination: `${API_ORIGIN}/media/:path*` },
    ];
  },
  async redirects() {
    // Cross-user social surfaces are purged from the cockpit (they return
    // later as a separate app); old links land on the home redirect.
    return [
      { source: "/favicon.ico", destination: "/icon.svg", permanent: true },
      { source: "/explore", destination: "/", permanent: false },
      { source: "/feed", destination: "/", permanent: false },
      // User-level surfaces moved under /account.
      { source: "/settings", destination: "/account", permanent: false },
      { source: "/manna", destination: "/account/manna", permanent: false },
    ];
  },
  images: {
    remotePatterns: [
      ...LEGACY_MEDIA_HOSTS.map((hostname) => ({ protocol: "https" as const, hostname })),
      // New media served by the api's static /media route (any port).
      { protocol: "http", hostname: "localhost" },
      { protocol: "http", hostname: "127.0.0.1" },
    ],
  },
};

export default nextConfig;
