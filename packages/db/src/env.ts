import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Load repo-root env files into `process.env` (variables already present in
 * the environment take precedence, per Node's `--env-file` semantics).
 *
 * Walks upward from `process.cwd()` so it works from the repo root, from any
 * workspace package (drizzle-kit runs with cwd = packages/db), and from
 * bundled contexts where `import.meta.url` is unreliable. Local overrides are
 * loaded before the base file without overriding exported shell variables.
 */
export function loadRootEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (['.env.local', '.env'].some((name) => existsSync(path.join(dir, name)))) {
      for (const name of ['.env.local', '.env']) {
        const candidate = path.join(dir, name);
        if (existsSync(candidate)) process.loadEnvFile(candidate);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
