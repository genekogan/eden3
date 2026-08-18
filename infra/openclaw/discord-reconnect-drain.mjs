/**
 * Tracks work admitted by one Discord provider generation.
 *
 * The implementation is intentionally dependency-free because its exact
 * source is injected into OpenClaw's digest-pinned distribution bundle at
 * image-build time. Tests import this same function and exercise the lifecycle
 * semantics before a derivative image is built.
 */
export function createEdenDiscordDrainTracker() {
  let accepting = true;
  const pending = new Set();

  return {
    reserve() {
      if (!accepting) return null;
      let settled = false;
      let resolvePending;
      const promise = new Promise((resolve) => {
        resolvePending = resolve;
      });
      pending.add(promise);
      return {
        settle() {
          if (settled) return;
          settled = true;
          pending.delete(promise);
          resolvePending();
        },
      };
    },
    stopAccepting() {
      accepting = false;
    },
    async drain(timeoutMs = 30_000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Discord drain timeout must be a positive integer');
      }
      accepting = false;
      const snapshot = [...pending];
      if (snapshot.length === 0) return { timedOut: false, pendingCount: 0 };
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([
        Promise.allSettled(snapshot).then(() => 'drained'),
        timeout,
      ]);
      clearTimeout(timer);
      return { timedOut: outcome === 'timeout' && pending.size > 0, pendingCount: pending.size };
    },
    pendingCount() {
      return pending.size;
    },
  };
}

export const edenDiscordDrainTrackerSource = createEdenDiscordDrainTracker.toString();
