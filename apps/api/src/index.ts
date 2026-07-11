// @eden3/api entrypoint — Fastify 5 on API_PORT (default 4301).
// Env loading happens here (entrypoints only); everything else reads
// process.env through @eden3/core getEnv().
import { getEnv } from '@eden3/core';
import { loadRootEnv } from '@eden3/db';
import { ensureBaseline } from '@eden3/gateway';

import { defaultOpenclawDataDir } from './gateway-glue';
import { buildServer } from './server';
import { refreshActiveConceptInventories } from './services/concepts';

loadRootEnv();
const env = getEnv();
await ensureBaseline({ dataDir: defaultOpenclawDataDir() });
await refreshActiveConceptInventories();

const app = await buildServer({
  logger: { level: 'info', base: undefined }, // compact: no pid/hostname
  media: { autoStartWatcher: true },
  scheduler: { autoStart: true }, // eden3-side scheduled-task firing
});

await app.listen({ port: env.API_PORT, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
