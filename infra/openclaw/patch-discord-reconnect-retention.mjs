import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { edenDiscordDrainTrackerSource } from './discord-reconnect-drain.mjs';

// OpenClaw 2026.7.1 tears down a Discord provider synchronously. Accepted
// handler admissions and run-queue jobs can therefore retain an entire stale
// provider generation while a replacement starts. During the R3.8 disconnect
// storm this produced a permanent RSS step and exposed accepted messages to
// teardown races. Backport the upstream lifecycle shape into the digest-pinned
// bundles: stop admissions, settle skipped work, drain running work, then let
// provider replacement continue. Exact anchors make an upstream layout change
// fail the image build rather than silently drop the guard.
const distDir = process.env.OPENCLAW_DIST_DIR ?? '/app/dist';
const candidates = (await readdir(distDir))
  .filter((name) => /^[A-Za-z0-9_.-]+\.js$/.test(name))
  .map((name) => path.join(distDir, name));

async function patchExactlyOne(label, replacements) {
  let patchedFiles = 0;
  for (const file of candidates) {
    const source = await readFile(file, 'utf8');
    const counts = replacements.map(({ anchor }) => source.split(anchor).length - 1);
    if (counts.every((count) => count === 0)) continue;
    const invalid = counts.findIndex(
      (count, index) => count !== replacements[index].expectedCount,
    );
    if (invalid !== -1) {
      throw new Error(
        `OpenClaw ${label} patch anchors changed in ${path.basename(file)} ` +
          `(${counts.join(',')})`,
      );
    }
    let next = source;
    for (const { anchor, replacement } of replacements) {
      next = next.split(anchor).join(replacement);
    }
    await writeFile(file, next, 'utf8');
    patchedFiles += 1;
  }
  if (patchedFiles !== 1) {
    throw new Error(`Expected one OpenClaw ${label} bundle to patch, found ${patchedFiles}`);
  }
}

await patchExactlyOne('Discord message lifecycle', [
  {
    expectedCount: 1,
    anchor: 'function createDiscordMessageRunQueue(params) {',
    replacement:
      `${edenDiscordDrainTrackerSource}\nfunction createDiscordMessageRunQueue(params) {` +
      '\n\tconst drainController = new AbortController();',
  },
  {
    expectedCount: 1,
    anchor:
      '\tlet lifecycleActive = !params.abortSignal?.aborted;\n' +
      '\tconst cleanupSkippedQueuedMessages = () => {',
    replacement:
      '\tlet lifecycleActive = true;\n' +
      '\tconst pendingTasks = createEdenDiscordDrainTracker();\n' +
      '\tconst cleanupSkippedQueuedMessages = () => {',
  },
  {
    expectedCount: 1,
    anchor:
      '\tconst runQueue = createChannelRunQueue({\n' +
      '\t\tsetStatus: params.setStatus,\n' +
      '\t\tabortSignal: params.abortSignal,',
    replacement:
      '\tconst runQueue = createChannelRunQueue({\n' +
      '\t\tsetStatus: params.setStatus,\n' +
      '\t\tabortSignal: drainController.signal,',
  },
  {
    expectedCount: 1,
    anchor: '\t\tfor (const cleanup of cleanups) cleanup();',
    replacement:
      '\t\tfor (const cleanup of cleanups) try {\n' +
      '\t\t\tcleanup();\n' +
      '\t\t} catch (error) {\n' +
      '\t\t\ttry {\n' +
      '\t\t\t\tparams.runtime.error(danger(`discord skipped message cleanup failed: ${String(error)}`));\n' +
      '\t\t\t} catch {}\n' +
      '\t\t}',
  },
  {
    expectedCount: 1,
    anchor:
      '\tif (params.abortSignal?.aborted) cleanupSkippedQueuedMessages();\n' +
      '\telse params.abortSignal?.addEventListener("abort", cleanupSkippedQueuedMessages, { once: true });',
    replacement:
      '\t// Provider abort stops new admissions in handler.deactivate; accepted work uses the local drain signal.',
  },
  {
    expectedCount: 1,
    anchor:
      '\treturn {\n' +
      '\t\tenqueue(job) {\n' +
      '\t\t\tconst cleanupSkipped = () => {\n' +
      '\t\t\t\tcleanupSkippedDiscordQueuedMessage({\n' +
      '\t\t\t\t\tjob,\n' +
      '\t\t\t\t\treplayGuard\n' +
      '\t\t\t\t});\n' +
      '\t\t\t};\n' +
      '\t\t\tif (!lifecycleActive) {\n' +
      '\t\t\t\tcleanupSkipped();\n' +
      '\t\t\t\treturn;\n' +
      '\t\t\t}\n' +
      '\t\t\tskippedCleanup.add(cleanupSkipped);\n' +
      '\t\t\trunQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {\n' +
      '\t\t\t\tskippedCleanup.delete(cleanupSkipped);\n' +
      '\t\t\t\tawait processDiscordQueuedMessage({\n' +
      '\t\t\t\t\tjob,\n' +
      '\t\t\t\t\tlifecycleSignal,\n' +
      '\t\t\t\t\treplayGuard,\n' +
      '\t\t\t\t\ttesting: params.testing\n' +
      '\t\t\t\t});\n' +
      '\t\t\t});\n' +
      '\t\t},\n' +
      '\t\tdeactivate() {\n' +
      '\t\t\trunQueue.deactivate();\n' +
      '\t\t\tcleanupSkippedQueuedMessages();\n' +
      '\t\t}\n' +
      '\t};',
    replacement:
      '\treturn {\n' +
      '\t\tenqueue(job) {\n' +
      '\t\t\tconst pendingTask = pendingTasks.reserve();\n' +
      '\t\t\tconst cleanupSkipped = () => {\n' +
      '\t\t\t\ttry {\n' +
      '\t\t\t\t\tcleanupSkippedDiscordQueuedMessage({\n' +
      '\t\t\t\t\t\tjob,\n' +
      '\t\t\t\t\t\treplayGuard\n' +
      '\t\t\t\t\t});\n' +
      '\t\t\t\t} finally {\n' +
      '\t\t\t\t\tpendingTask?.settle();\n' +
      '\t\t\t\t}\n' +
      '\t\t\t};\n' +
      '\t\t\tif (!pendingTask || !lifecycleActive) {\n' +
      '\t\t\t\ttry {\n' +
      '\t\t\t\t\tcleanupSkipped();\n' +
      '\t\t\t\t} catch (cleanupError) {\n' +
      '\t\t\t\t\ttry {\n' +
      '\t\t\t\t\t\tparams.runtime.error(danger(`discord skipped message cleanup failed: ${String(cleanupError)}`));\n' +
      '\t\t\t\t\t} catch {}\n' +
      '\t\t\t\t}\n' +
      '\t\t\t\treturn;\n' +
      '\t\t\t}\n' +
      '\t\t\tskippedCleanup.add(cleanupSkipped);\n' +
      '\t\t\ttry {\n' +
      '\t\t\t\trunQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {\n' +
      '\t\t\t\t\tskippedCleanup.delete(cleanupSkipped);\n' +
      '\t\t\t\t\ttry {\n' +
      '\t\t\t\t\t\tawait processDiscordQueuedMessage({\n' +
      '\t\t\t\t\t\t\tjob,\n' +
      '\t\t\t\t\t\t\tlifecycleSignal,\n' +
      '\t\t\t\t\t\t\treplayGuard,\n' +
      '\t\t\t\t\t\t\ttesting: params.testing\n' +
      '\t\t\t\t\t\t});\n' +
      '\t\t\t\t\t} finally {\n' +
      '\t\t\t\t\t\tpendingTask.settle();\n' +
      '\t\t\t\t\t}\n' +
      '\t\t\t\t});\n' +
      '\t\t\t} catch (error) {\n' +
      '\t\t\t\tskippedCleanup.delete(cleanupSkipped);\n' +
      '\t\t\t\ttry {\n' +
      '\t\t\t\t\tcleanupSkipped();\n' +
      '\t\t\t\t} catch (cleanupError) {\n' +
      '\t\t\t\t\ttry {\n' +
      '\t\t\t\t\t\tparams.runtime.error(danger(`discord skipped message cleanup failed: ${String(cleanupError)}`));\n' +
      '\t\t\t\t\t} catch {}\n' +
      '\t\t\t\t}\n' +
      '\t\t\t\ttry {\n' +
      '\t\t\t\t\tparams.runtime.error(danger(`discord message enqueue failed: ${String(error)}`));\n' +
      '\t\t\t\t} catch {}\n' +
      '\t\t\t}\n' +
      '\t\t},\n' +
      '\t\tasync deactivate() {\n' +
      '\t\t\tpendingTasks.stopAccepting();\n' +
      '\t\t\tconst drained = await pendingTasks.drain(25_000);\n' +
      '\t\t\tif (drained.timedOut) {\n' +
      '\t\t\t\ttry {\n' +
      '\t\t\t\t\tparams.runtime.error(danger(`discord message drain timed out with ${drained.pendingCount} pending; terminating stale generation`));\n' +
      '\t\t\t\t} catch {}\n' +
      '\t\t\t\tprocess.exit(1);\n' +
      '\t\t\t}\n' +
      '\t\t\trunQueue.deactivate();\n' +
      '\t\t\tcleanupSkippedQueuedMessages();\n' +
      '\t\t},\n' +
      '\t\tlifecycleSignal: drainController.signal\n' +
      '\t};',
  },
  {
    expectedCount: 1,
    anchor:
      '\tconst { debouncer } = createChannelInboundDebouncer({\n' +
      '\t\tcfg: params.cfg,\n' +
      '\t\tchannel: "discord",',
    replacement:
      '\tconst { debouncer } = createChannelInboundDebouncer({\n' +
      '\t\tcfg: params.cfg,\n' +
      '\t\tchannel: "discord",\n' +
      '\t\tdebounceMsOverride: 0,',
  },
  {
    expectedCount: 1,
    anchor: '\t\t\t\tabortSignal: options?.abortSignal,',
    replacement: '\t\t\t\tabortSignal: messageRunQueue.lifecycleSignal,',
  },
  {
    expectedCount: 1,
    anchor: '\tconst handler = async (data, client, options) => {\n\t\ttry {',
    replacement:
      '\tconst activeAdmissions = createEdenDiscordDrainTracker();\n' +
      '\tconst handler = async (data, client, options) => {\n' +
      '\t\tconst admission = activeAdmissions.reserve();\n' +
      '\t\tif (!admission) return;\n' +
      '\t\ttry {\n' +
      '\t\t\ttry {',
  },
  {
    expectedCount: 1,
    anchor:
      '\t\t} catch (err) {\n' +
      '\t\t\tparams.runtime.error(danger(`handler failed: ${String(err)}`));\n' +
      '\t\t}\n' +
      '\t};\n' +
      '\thandler.deactivate = messageRunQueue.deactivate;',
    replacement:
      '\t\t\t} catch (err) {\n' +
      '\t\t\t\tparams.runtime.error(danger(`handler failed: ${String(err)}`));\n' +
      '\t\t\t}\n' +
      '\t\t} finally {\n' +
      '\t\t\tadmission.settle();\n' +
      '\t\t}\n' +
      '\t};\n' +
      '\thandler.deactivate = async () => {\n' +
      '\t\tactiveAdmissions.stopAccepting();\n' +
      '\t\tconst admissions = await activeAdmissions.drain(5_000);\n' +
      '\t\tif (admissions.timedOut) {\n' +
      '\t\t\ttry {\n' +
      '\t\t\t\tparams.runtime.error(danger(`discord admission drain timed out with ${admissions.pendingCount} pending; terminating stale generation`));\n' +
      '\t\t\t} catch {}\n' +
      '\t\t\tprocess.exit(1);\n' +
      '\t\t}\n' +
      '\t\tawait messageRunQueue.deactivate();\n' +
      '\t};',
  },
]);

await patchExactlyOne('Discord provider lifecycle', [
  {
    expectedCount: 1,
    anchor: '\t\tPromise.resolve().then(() => this.handler(data, client)).catch((err) => {',
    replacement: '\t\tthis.handler(data, client).catch((err) => {',
  },
  {
    expectedCount: 1,
    anchor:
      'function cleanupDiscordProviderStartup(params) {\n' +
      '\tparams.deactivateMessageHandler?.();',
    replacement:
      'async function cleanupDiscordProviderStartup(params) {\n' +
      '\tawait params.deactivateMessageHandler?.();',
  },
  {
    expectedCount: 1,
    anchor: '\t\tcleanupDiscordProviderStartup({\n\t\t\tdeactivateMessageHandler,',
    replacement: '\t\tawait cleanupDiscordProviderStartup({\n\t\t\tdeactivateMessageHandler,',
  },
]);
