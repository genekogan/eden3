import { describe, expect, it } from 'vitest';

import { waitForBestEffortHistoryRefresh } from '../src/routes/sessions';

describe('best-effort session history refresh', () => {
  it('distinguishes completion, failure, and a bounded gateway stall', async () => {
    await expect(waitForBestEffortHistoryRefresh(Promise.resolve())).resolves.toBe('completed');
    await expect(
      waitForBestEffortHistoryRefresh(Promise.reject(new Error('gateway unavailable'))),
    ).resolves.toBe('failed');
    await expect(
      waitForBestEffortHistoryRefresh(new Promise(() => {}), 5),
    ).resolves.toBe('timed_out');
  });
});
