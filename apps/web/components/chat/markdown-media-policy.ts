const MEDIA_OBJECT_ID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

const PRIVATE_MEDIA_PATH = new RegExp(`^/media/${MEDIA_OBJECT_ID}$`);
const SHARED_MEDIA_PATH = new RegExp(
  `^/media/share/[A-Za-z0-9_-]{32,200}/${MEDIA_OBJECT_ID}$`,
);

const LEGACY_MEDIA_HOSTS = new Set(
  (process.env.NEXT_PUBLIC_LEGACY_MEDIA_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => /^[a-z0-9.-]+$/.test(host)),
);

/**
 * Markdown is untrusted agent/provider text. Keep image fetching limited to
 * Eden's exact media capabilities and the frozen legacy asset origins. This
 * deliberately rejects arbitrary HTTPS URLs as well as browser-local targets.
 */
export function isAllowedMarkdownImageSource(source: string): boolean {
  if (source.length === 0 || source.length > 4096) return false;
  if (PRIVATE_MEDIA_PATH.test(source) || SHARED_MEDIA_PATH.test(source)) return true;
  if (source.startsWith("/")) return false;

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.hash === "" &&
    LEGACY_MEDIA_HOSTS.has(url.hostname)
  );
}
