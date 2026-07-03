// @eden3/api entrypoint — Fastify 5 on API_PORT (default 4301).
// Env loading happens here (entrypoints only); everything else reads
// process.env through @eden3/core getEnv().
import { getEnv } from '@eden3/core';
import { loadRootEnv } from '@eden3/db';

import { buildServer } from './server';

loadRootEnv();
const env = getEnv();

const app = await buildServer({
  logger: { level: 'info', base: undefined }, // compact: no pid/hostname
});

await app.listen({ port: env.API_PORT, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
