import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_CONTENT_RULES,
  scanTrackedCredentialExposure,
  secretLikeFilename,
} from './credential-exposure.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

function initRepository(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'eden3-credential-scan-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [file, value] of Object.entries(files)) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, value);
  }
  execFileSync('git', ['add', '--all'], { cwd: root });
  return root;
}

const syntheticTokens = [
  ['private-key', ['-----BEGIN ', 'TEST PRIVATE KEY-----'].join('')],
  ['aws-access-key', ['AKIA', 'A'.repeat(16)].join('')],
  ['github-token', ['ghp_', 'a'.repeat(30)].join('')],
  ['github-fine-grained-token', ['github_pat_', 'a'.repeat(30)].join('')],
  ['anthropic-key', ['sk-ant-', 'a'.repeat(20)].join('')],
  ['openai-project-key', ['sk-proj-', 'a'.repeat(20)].join('')],
  ['generic-secret-key', ['sk-', 'a'.repeat(32)].join('')],
  ['slack-token', ['xoxb-', 'a'.repeat(10)].join('')],
  ['google-api-key', ['AIza', 'a'.repeat(35)].join('')],
  ['stripe-live-key', ['sk', '_live_', 'a'.repeat(20)].join('')],
  ['gitlab-token', ['glpat-', 'a'.repeat(20)].join('')],
];

test('every high-confidence content rule reports only file, rule, and line metadata', () => {
  assert.deepEqual(CREDENTIAL_CONTENT_RULES.map(([rule]) => rule), syntheticTokens.map(([rule]) => rule));
  for (const [rule, token] of syntheticTokens) {
    const root = initRepository({ 'safe.txt': `prefix\n${token}\nsuffix\n` });
    const result = scanTrackedCredentialExposure(root);
    assert.deepEqual(result, {
      filesScanned: 1,
      findings: [{ file: 'safe.txt', rule, line: 2 }],
    });
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test('secret-like tracked filenames fail while documented templates remain allowed', () => {
  const blocked = [
    '.env', 'config/prod.env', 'config/.env.local', 'id_ed25519', 'keys/key.pem',
    'keys/key.p12', 'keys/key.pfx', 'keys/key.keystore', 'keys/key.jks', '.npmrc',
    'nested/.pypirc', '.git-credentials', '.netrc', 'credentials.json',
    'service-account-prod.json', 'client_secret_web.json',
  ];
  for (const file of blocked) assert.equal(secretLikeFilename(file), true, file);
  for (const file of [
    '.env.example', 'nested/app.env.sample', 'app.env.template', 'app.env.dist',
    'credentials.example.json', 'client_secrets.md', 'ordinary.json',
  ]) assert.equal(secretLikeFilename(file), false, file);
});

test('the scan covers tracked binary bytes without following tracked symlinks', () => {
  const token = ['ghp_', 'b'.repeat(30)].join('');
  const root = initRepository({ 'binary.bin': Buffer.concat([Buffer.from([0, 1]), Buffer.from(token)]) });
  const outside = path.join(root, '..', `${path.basename(root)}-outside`);
  writeFileSync(outside, token);
  symlinkSync(outside, path.join(root, 'link.txt'));
  execFileSync('git', ['add', 'link.txt'], { cwd: root });
  const result = scanTrackedCredentialExposure(root);
  assert.deepEqual(result.findings, [{ file: 'binary.bin', rule: 'github-token', line: 1 }]);
});

test('the scan independently covers divergent index and working-tree bytes', () => {
  const stagedToken = ['ghp_', 'c'.repeat(30)].join('');
  const stagedRoot = initRepository({ 'tracked.txt': stagedToken });
  writeFileSync(path.join(stagedRoot, 'tracked.txt'), 'safe working tree\n');
  assert.deepEqual(scanTrackedCredentialExposure(stagedRoot).findings, [
    { file: 'tracked.txt', rule: 'github-token', line: 1 },
  ]);

  const workingToken = ['glpat-', 'd'.repeat(20)].join('');
  const workingRoot = initRepository({ 'tracked.txt': 'safe index\n' });
  writeFileSync(path.join(workingRoot, 'tracked.txt'), workingToken);
  assert.deepEqual(scanTrackedCredentialExposure(workingRoot).findings, [
    { file: 'tracked.txt', rule: 'gitlab-token', line: 1 },
  ]);
});

test('the scan refuses a tracked submodule entry before reading outside the repository', () => {
  const root = initRepository({});
  execFileSync('git', [
    'update-index', '--add', '--info-only', '--cacheinfo',
    `160000,${'1'.repeat(40)},vendor`,
  ], { cwd: root });
  assert.throws(
    () => scanTrackedCredentialExposure(root),
    /refuses non-blob index entry: "vendor"/,
  );
});

test('the current tracked repository has no high-confidence credential exposure', () => {
  const result = scanTrackedCredentialExposure(REPOSITORY_ROOT);
  assert.equal(result.filesScanned > 900, true);
  assert.deepEqual(result.findings, []);
});
