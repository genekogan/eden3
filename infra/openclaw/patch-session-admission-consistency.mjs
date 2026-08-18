import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveSessionAdmissionIdentity } from './session-admission-policy.mjs';

// OpenClaw 2026.7.1 resolves a session before lifecycle admission. On the
// first follow-up to a newly created key, the preparation view can still be
// empty while admission's durable latest-read already contains the winning
// session id. Adopt that durable id only for the exact first-use transition;
// all established-session mismatches continue through the upstream guard.
// Exact anchors make an upstream bundle change fail the image build.
const distDir = process.env.EDEN3_OPENCLAW_DIST_DIR || '/app/dist';
const candidates = (await readdir(distDir))
  .filter((name) => /^[A-Za-z0-9_.-]+\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const functionAnchor = 'async function agentCommandInternal(initialOpts, runtime = defaultRuntime, deps) {';
const destructureAnchor =
  'const { body, transcriptBody, cfg, configuredThinkingCatalog, normalizedSpawned, agentCfg, thinkOverride, thinkOnce, verboseOverride, timeoutMs, runTimeoutOverrideMs, sessionId, sessionKey, sessionStore, storePath, isNewSession, persistedThinking, persistedVerbose, sessionAgentId, outboundSession, workspaceDir, cwd, agentDir, runId, isSubagentLane, acpManager, acpResolution, pluginsEnabled, manifestMetadataSnapshot, modelManifestContext } = prepared;';
const effectiveCwdAnchor = 'const effectiveCwd = cwd ? resolveUserPath(cwd) : workspaceDir;';
const preparedSessionIdAnchor = 'const preparedSessionId = sessionEntry?.sessionId;';
const runtimeAnchor =
  'const sessionStoreRuntime = storePath && sessionKey ? await loadSessionStoreRuntime() : void 0;';
const lifecycleImportAnchor =
  'import { c as resolveSessionWorkStartError } from "./lifecycle-BS_t5emX.js";';
const lifecycleImportReplacement =
  'import { a as hasTerminalMainSessionTranscriptNewerThanRegistrySync, c as resolveSessionWorkStartError, s as resolveSessionLifecycleTimestamps } from "./lifecycle-BS_t5emX.js";\n' +
  'import { t as hasProviderOwnedSession } from "./entry-freshness-CkdkmOZ4.js";\n' +
  'import { c as resolveSessionResetPolicy, n as resolveChannelResetConfig, o as evaluateSessionFreshness, r as resolveSessionResetType } from "./reset-Bw63W6T_.js";';
const admissionIdentitiesAnchor = 'identities: [sessionKey, sessionId],';
const lifecycleGuardsAnchor =
  'if (!currentEntry && preparedSessionId) throw new Error(`Session "${sessionKey ?? sessionId}" changed while starting work. Retry.`);\n' +
  '\t\t\tconst matchesIntentionalRollover = isNewSession && currentEntry?.sessionId === preparedSessionId;\n' +
  '\t\t\tif (currentEntry && currentEntry.sessionId !== sessionId && !matchesIntentionalRollover) throw new Error(`Session "${sessionKey ?? sessionId}" changed while starting work. Retry.`);\n' +
  '\t\t\tconst archivedSessionError = resolveSessionWorkStartError(sessionKey ?? sessionId, currentEntry);\n' +
  '\t\t\tif (archivedSessionError) throw new Error(archivedSessionError);';
const adoptionBlock = `${runtimeAnchor}
\tif (sessionStoreRuntime && storePath && sessionKey) {
\t\tconst latestEntry = sessionStoreRuntime.loadSessionEntry({
\t\t\tstorePath,
\t\t\tsessionKey,
\t\t\treadConsistency: "latest"
\t\t});
\t\tconst nowMs = Date.now();
\t\tconst currentResetPolicy = resolveSessionResetPolicy({
\t\t\tsessionCfg: cfg.session,
\t\t\tresetType: resolveSessionResetType({ sessionKey }),
\t\t\tresetOverride: resolveChannelResetConfig({
\t\t\t\tsessionCfg: cfg.session,
\t\t\t\tchannel: latestEntry?.lastChannel ?? latestEntry?.channel ?? latestEntry?.origin?.provider
\t\t\t})
\t\t});
\t\tconst terminalMainTranscriptNewerThanRegistry = latestEntry && !initialOpts.sessionId?.trim() ? hasTerminalMainSessionTranscriptNewerThanRegistrySync({
\t\t\tentry: latestEntry,
\t\t\tsessionScope: cfg.session?.scope,
\t\t\tsessionKey,
\t\t\tagentId: sessionAgentId,
\t\t\tmainKey: cfg.session?.mainKey,
\t\t\tstorePath
\t\t}) : false;
\t\tconst skipImplicitExpiry = currentResetPolicy.configured !== true && hasProviderOwnedSession(latestEntry);
\t\tconst currentFresh = latestEntry ? !terminalMainTranscriptNewerThanRegistry && (skipImplicitExpiry || evaluateSessionFreshness({
\t\t\tupdatedAt: latestEntry.updatedAt,
\t\t\t...resolveSessionLifecycleTimestamps({
\t\t\t\tentry: latestEntry,
\t\t\t\tagentId: sessionAgentId,
\t\t\t\tstorePath
\t\t\t}),
\t\t\tnow: nowMs,
\t\t\tpolicy: currentResetPolicy
\t\t}).fresh) : false;
\t\tconst admittedIdentity = resolveSessionAdmissionIdentity({
\t\t\tisNewSession,
\t\t\tpreparedSessionId,
\t\t\tresolvedSessionId: sessionId,
\t\t\tcurrentSessionId: latestEntry?.sessionId,
\t\t\tcurrentFresh,
\t\t\tcurrentStatus: latestEntry?.status,
\t\t\thasRequestedSessionId: Boolean(initialOpts.sessionId?.trim())
\t\t});
\t\tif (admittedIdentity.adopted) {
\t\t\tsessionId = admittedIdentity.sessionId;
\t\t\tisNewSession = admittedIdentity.isNewSession;
\t\t\tpreparedSessionId = admittedIdentity.sessionId;
\t\t\tpersistedThinking = latestEntry.thinkingLevel ? normalizeThinkLevel(latestEntry.thinkingLevel) : void 0;
\t\t\tpersistedVerbose = latestEntry.verboseLevel ? normalizeVerboseLevel(latestEntry.verboseLevel) : void 0;
\t\t\tcwd = normalizeOptionalString(opts.cwd) ?? normalizeOptionalString(latestEntry.spawnedCwd);
\t\t\teffectiveCwd = cwd ? resolveUserPath(cwd) : workspaceDir;
\t\t\tsessionEntry = latestEntry;
\t\t\tif (sessionStore) sessionStore[sessionKey] = latestEntry;
\t\t}
\t}`;

const replacements = [
  {
    anchor: functionAnchor,
    replacement: `${resolveSessionAdmissionIdentity.toString()}\n${functionAnchor}`,
  },
  { anchor: destructureAnchor, replacement: destructureAnchor.replace(/^const /, 'let ') },
  { anchor: effectiveCwdAnchor, replacement: effectiveCwdAnchor.replace(/^const /, 'let ') },
  {
    anchor: preparedSessionIdAnchor,
    replacement: preparedSessionIdAnchor.replace(/^const /, 'let '),
  },
  { anchor: runtimeAnchor, replacement: adoptionBlock },
  { anchor: lifecycleImportAnchor, replacement: lifecycleImportReplacement },
  // These no-op anchors are security regression tripwires: the patch may
  // adopt only before admission and must retain key-based mutation exclusion,
  // rebind/deletion rejection, and archived-session rejection verbatim.
  { anchor: admissionIdentitiesAnchor, replacement: admissionIdentitiesAnchor },
  { anchor: lifecycleGuardsAnchor, replacement: lifecycleGuardsAnchor },
];

let patchedFiles = 0;
for (const file of candidates) {
  const source = await readFile(file, 'utf8');
  const counts = replacements.map(({ anchor }) => source.split(anchor).length - 1);
  // The unchanged guard text also exists in other lifecycle consumers. A
  // target is identified by the four agent-command-specific mutation anchors;
  // only then must every guard/tripwire anchor be present exactly once.
  if (counts.slice(0, 5).every((count) => count === 0)) continue;
  if (counts.some((count) => count !== 1)) {
    throw new Error(
      `OpenClaw session-admission anchors changed in ${path.basename(file)} (${counts.join(',')})`,
    );
  }
  let next = source;
  for (const { anchor, replacement } of replacements) next = next.replace(anchor, replacement);
  await writeFile(file, next, 'utf8');
  patchedFiles += 1;
}

if (patchedFiles !== 1) {
  throw new Error(`Expected one session-admission bundle to patch, found ${patchedFiles}`);
}
