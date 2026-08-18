import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Egress policy — "open exterior, sealed interior" (decided 2026-07-10).
 *
 * Agents get general outbound web (80/443 to the PUBLIC internet: browsing,
 * news, APIs) because the capability IS the product (SPEC Q1). What must
 * never be reachable from a sandbox is the interior: this host's services
 * (gateway admin surface, Postgres, Mongo), anything on private/link-local
 * ranges, cloud metadata endpoints, and abuse-only ports (SMTP et al —
 * enforced by the 80/443 port allowlist).
 *
 * Enforcement is resolve-then-pin: hostnames are resolved HERE, every
 * resolved address is classified, and the upstream connection goes to the
 * vetted IP — a DNS-rebinding flip between check and connect cannot reach a
 * different address. Docker-internal service names are single-label
 * hostnames and are rejected before resolution.
 *
 * Modes (EDEN3_EGRESS_MODE):
 *  - "open" (default): public internet allowed, interior blocked.
 *  - "allowlist": the legacy provider-allowlist behavior (EDEN3_EGRESS_ALLOWLIST)
 *    — kept for rollback; the interior IP checks still apply on top.
 */

export const DEFAULT_MODE = 'open';

/** Hostname-level rejections that never make it to DNS. */
export function blockedHostname(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return 'empty host';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback name';
  // Docker service names / bare intranet names are single-label (no dot).
  // IP literals contain dots/colons and are classified separately.
  if (!host.includes('.') && !host.includes(':')) return 'single-label host';
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.lan')) {
    return 'internal name suffix';
  }
  if (host === 'metadata.google.internal' || host === 'metadata') return 'metadata endpoint';
  return null;
}

/**
 * Expand an IPv6 string into its 8 16-bit groups (or null if unparseable).
 * Handles `::` compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`).
 * String-prefix classification of IPv6 is unsafe — the WHATWG URL parser
 * rewrites `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1`, and `::1` has
 * many non-canonical spellings — so we canonicalize before classifying.
 */
function expandIpv6(value) {
  let s = String(value ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  // Fold a trailing dotted-quad into two hex groups.
  const v4 = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = [v4[2], v4[3], v4[4], v4[5]].map(Number);
    if (o.some((x) => x > 255)) return null;
    s = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (g === '' ? NaN : parseInt(g, 16)));
  if (out.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) return null;
  return out;
}

function blockedIpv4(a, b) {
  if (a === 0) return 'unspecified range';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private 10/8';
  if (a === 172 && b >= 16 && b <= 31) return 'private 172.16/12';
  if (a === 192 && b === 168) return 'private 192.168/16';
  if (a === 169 && b === 254) return 'link-local/metadata 169.254/16';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat 100.64/10';
  if (a >= 224) return 'multicast/reserved';
  return null;
}

/** Classify one IP (v4 or v6 string). Returns a reason when blocked. */
export function blockedAddress(address) {
  const ip = String(address ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(ip) === 0) return 'not an ip';

  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return blockedIpv4(a, b);
  }

  // IPv6 — canonicalize, then classify on the expanded groups.
  const g = expandIpv6(ip);
  if (!g) return 'unparseable ipv6';

  // Specific v6 addresses first (so ::1 isn't mistaken for ::0.0.0.1).
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';

  // v4-mapped (::ffff:a.b.c.d) and deprecated v4-compatible (::a.b.c.d): the
  // high bits are zero — classify the embedded IPv4 in ANY spelling. This is
  // the hole the review caught: ::ffff:7f00:1 → 127.0.0.1 was slipping past
  // the old dotted-decimal-only regex.
  const highZero = g.slice(0, 5).every((x) => x === 0);
  if (highZero && (g[5] === 0xffff || g[5] === 0)) {
    const reason = blockedIpv4(g[6] >> 8, g[6] & 0xff);
    if (reason) return reason;
    if (g[5] === 0xffff) return null; // public v4 via mapped form is fine
  }

  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local fe80::/10';
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local fc00::/7';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/**
 * Resolve + vet a target host. Returns `{ok: true, address}` with a pinned
 * address safe to connect to, or `{ok: false, reason}`. EVERY resolved
 * address must be public — a name mixing public and private records is
 * rejected outright (rebinding smell).
 */
export async function vetTarget(hostname, { lookup = dnsLookup } = {}) {
  // Strip IPv6 literal brackets so a bracketed literal is classified as an
  // address (not fall through to a fail-closed DNS lookup we shouldn't rely on).
  const host = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');

  const nameBlock = blockedHostname(host);
  if (nameBlock) return { ok: false, reason: nameBlock };

  if (net.isIP(host) !== 0) {
    const reason = blockedAddress(host);
    return reason ? { ok: false, reason } : { ok: true, address: host };
  }

  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'dns resolution failed' };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: 'dns returned no addresses' };
  }
  for (const record of records) {
    const reason = blockedAddress(record.address);
    if (reason) return { ok: false, reason: `resolved to blocked address (${reason})` };
  }
  // Prefer IPv4 for the pinned connection (the sandbox network is v4).
  const preferred = records.find((r) => r.family === 4) ?? records[0];
  return { ok: true, address: preferred.address };
}

export function parseMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'allowlist' ? 'allowlist' : DEFAULT_MODE;
}
