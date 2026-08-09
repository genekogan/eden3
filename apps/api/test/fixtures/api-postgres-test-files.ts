/**
 * API test files that execute real PostgreSQL semantics. The ordinary Vitest
 * command excludes this exact set; the dedicated required config includes it.
 * A missing entry fails safely against the unit sentinel instead of reaching a
 * protected database.
 */
export const API_POSTGRES_TEST_FILES = [
  'test/access-gate.test.ts',
  'test/account-export-routes.test.ts',
  'test/agent-runtime-sync.test.ts',
  'test/agent-scoped-params.test.ts',
  'test/agents-routes.test.ts',
  'test/auth-routes.test.ts',
  'test/automation-budget.test.ts',
  'test/billing-routes.test.ts',
  'test/channel-runtime-routes.test.ts',
  'test/channels-routes.test.ts',
  'test/chat-limits.test.ts',
  'test/clerk-auth-provider.test.ts',
  'test/collections-routes.test.ts',
  'test/concepts-routes.test.ts',
  'test/creations-routes.test.ts',
  'test/default-assistant.test.ts',
  'test/dev-routes.test.ts',
  'test/events-bus-route.test.ts',
  'test/feed-routes.test.ts',
  'test/fg-econ-battery.test.ts',
  'test/fg-econ-chat-media.test.ts',
  'test/fg-econ-crash-reaper.test.ts',
  'test/fg-econ-studio.test.ts',
  'test/likes-routes.test.ts',
  'test/manna-routes.test.ts',
  'test/media-pipeline.test.ts',
  'test/memory-distillation.test.ts',
  'test/memory-dream-recovery-auth.test.ts',
  'test/memory-dreaming.test.ts',
  'test/operator-routes.test.ts',
  'test/search-routes.test.ts',
  'test/server.test.ts',
  'test/skills-routes.test.ts',
  'test/studio-reservation-reaper.test.ts',
  'test/studio-routes.test.ts',
  'test/task-scheduler.test.ts',
  'test/triggers-routes.test.ts',
  'test/turn-reservation-reaper.test.ts',
  'test/turns-authorization.test.ts',
  'test/turns-refund.test.ts',
  'test/turns-usage.test.ts',
  'test/workspace-routes.test.ts',
] as const;

export const API_GATED_POSTGRES_TEST_FILES = [
  'test/agent-provisioning-notification-pg.test.ts',
  'test/e2e-scratch-fixture-pg.test.ts',
] as const;

export const API_ALL_POSTGRES_TEST_FILES = [
  ...API_POSTGRES_TEST_FILES,
  ...API_GATED_POSTGRES_TEST_FILES,
].sort();

const COMMAND_WORDS = new Set(['run', 'watch', 'related', 'vitest']);

export function postgresFileMatchingUnitSelector(
  argv: readonly string[],
): string | undefined {
  for (const raw of argv) {
    if (raw.startsWith('-') || COMMAND_WORDS.has(raw)) continue;
    const selector = raw.replaceAll('\\', '/');
    for (const file of API_ALL_POSTGRES_TEST_FILES) {
      if (
        file.includes(selector) ||
        selector.endsWith(`/${file}`) ||
        selector.endsWith(`/${file.slice('test/'.length)}`)
      ) {
        return file;
      }
    }
  }
  return undefined;
}

export function assertApiUnitTestSelectors(argv: readonly string[]): void {
  if (postgresFileMatchingUnitSelector(argv)) {
    throw new Error(
      'PostgreSQL-backed API tests require `pnpm --filter @eden3/api test:postgres` or `test:full` with a disposable database',
    );
  }
}
