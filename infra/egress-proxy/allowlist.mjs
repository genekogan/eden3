export const DEFAULT_ALLOWLIST = Object.freeze([
  'api.anthropic.com',
  'api.openai.com',
  'api.openrouter.ai',
  'generativelanguage.googleapis.com',
  'api.fal.ai',
  'fal.ai',
  '*.fal.ai',
  'fal.run',
  '*.fal.run',
  'api.replicate.com',
  'replicate.com',
  '*.replicate.delivery',
  'api.stripe.com',
  'checkout.stripe.com',
  'api.clerk.com',
  '*.clerk.accounts.dev',
  // Package-install capability in legacy allowlist mode. In the default open
  // mode these hosts are already public exterior; the sealed-interior address
  // checks still apply in both modes.
  'pypi.org',
  'files.pythonhosted.org',
]);

function normalizeHost(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

export function parseAllowlist(value, defaults = DEFAULT_ALLOWLIST) {
  const raw = String(value ?? '').trim();
  const entries = raw === '' ? defaults : raw.split(',');
  return [...new Set(entries.map(normalizeHost).filter(Boolean))];
}

export function isAllowedHost(host, allowlist) {
  const normalizedHost = normalizeHost(host);
  if (normalizedHost === '') return false;
  for (const rawEntry of allowlist) {
    const entry = normalizeHost(rawEntry);
    if (entry === normalizedHost) return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      if (normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length) {
        return true;
      }
    }
  }
  return false;
}

export function parseAllowedPorts(value, defaults = [80, 443]) {
  const raw = String(value ?? '').trim();
  const entries = raw === '' ? defaults : raw.split(',');
  const out = [];
  for (const entry of entries) {
    const port = Number.parseInt(String(entry).trim(), 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) out.push(port);
  }
  return [...new Set(out)];
}
