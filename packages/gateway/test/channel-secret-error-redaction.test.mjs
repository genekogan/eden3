import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PATCH = path.join(REPO_ROOT, 'infra/openclaw/patch-channel-secret-error-redaction.mjs');

describe('pinned OpenClaw channel SecretRef error redaction', () => {
  it('removes durable channel capability ids from every exec resolution error shape', async () => {
    const dockerfile = await readFile(path.join(REPO_ROOT, 'infra/openclaw/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY patch-channel-secret-error-redaction.mjs');
    expect(dockerfile).toContain('node /usr/local/lib/eden3/patch-channel-secret-error-redaction.mjs');
    const dir = await mkdtemp(path.join(tmpdir(), 'eden3-channel-error-redaction-'));
    const bundle = path.join(dir, 'secrets-pinned.js');
    await writeFile(
      bundle,
      [
        'message: `Exec provider "${params.providerName}" failed for id "${id}" (${entry.message.trim()}).`',
        'message: `Exec provider "${params.providerName}" failed for id "${id}".`',
        'message: `Exec provider "${params.providerName}" response missing id "${id}".`',
      ].join('\n'),
      'utf8',
    );
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [PATCH], {
          env: { ...process.env, OPENCLAW_DIST_DIR: dir },
          stdio: 'pipe',
        });
        let error = '';
        child.stderr.on('data', (chunk) => (error += String(chunk)));
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`patch exited ${code}: ${error}`)),
        );
      });
      const patched = await readFile(bundle, 'utf8');
      expect(patched).toContain('failed for a protected channel credential');
      expect(patched).toContain('response omitted a protected channel credential');
      expect(patched).toContain('params.providerName === "eden-channel-vault"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
