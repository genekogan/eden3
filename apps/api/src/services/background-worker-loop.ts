export interface BackgroundWorkerLoopOptions<T> {
  intervalMs: number;
  tick: () => Promise<T>;
  onResult: (result: T) => void;
  onError: (error: unknown) => void;
  schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  cancel?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface BackgroundWorkerLoop {
  stop(): Promise<void>;
}

export const MAX_NODE_INTERVAL_MS = 2_147_483_647;

/**
 * Run one worker immediately, then on an unref'd interval. An interval firing
 * while the prior tick is still active is intentionally coalesced.
 */
export async function startBackgroundWorkerLoop<T>(
  options: BackgroundWorkerLoopOptions<T>,
): Promise<BackgroundWorkerLoop> {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs <= 0 ||
    options.intervalMs > MAX_NODE_INTERVAL_MS
  ) {
    throw new Error(`background worker interval must be an integer between 1 and ${MAX_NODE_INTERVAL_MS}`);
  }

  const schedule = options.schedule ?? setInterval;
  const cancel = options.cancel ?? clearInterval;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<boolean> => {
    if (stopped || inFlight) return false;
    const execution = Promise.resolve()
      .then(options.tick)
      .then(options.onResult)
      .catch(options.onError)
      .finally(() => {
        if (inFlight === execution) inFlight = null;
      });
    inFlight = execution;
    await execution;
    return true;
  };

  await run();
  const timer = schedule(() => {
    void run();
  }, options.intervalMs);
  timer.unref?.();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      cancel(timer);
      await inFlight;
    },
  };
}
