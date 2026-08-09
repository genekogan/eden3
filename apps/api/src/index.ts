// @eden3/api entrypoint — Fastify 5 on API_PORT (default 4301).
// Env loading happens here (entrypoints only); everything else reads
// process.env through @eden3/core getEnv().
import { getEnv } from '@eden3/core';
import { checkSchemaReadiness, loadRootEnv } from '@eden3/db';
import { ensureBaseline } from '@eden3/gateway';

import { defaultOpenclawDataDir } from './gateway-glue';
import { assertProductionBoundary } from './production-boundary';
import { buildServer } from './server';
import { refreshActiveConceptInventories } from './services/concepts';
import { runtimeAttestationFromEnvironment } from './services/runtime-attestation';

loadRootEnv();
const env = getEnv();
assertProductionBoundary(env);
await ensureBaseline({ dataDir: defaultOpenclawDataDir() });
await refreshActiveConceptInventories();
const runtimeAttestation = runtimeAttestationFromEnvironment();

const app = await buildServer({
  logger: { level: 'info', base: undefined }, // compact: no pid/hostname
  health: {
    schemaReadiness: checkSchemaReadiness,
    ...(runtimeAttestation
      ? { runtimeAttestation }
      : {}),
  },
  media: { autoStartWatcher: true },
  storage: { enabled: true, autoStartPolicyWorker: true },
  scheduler: { autoStart: true }, // eden3-side scheduled-task firing
});

await app.listen({ port: env.API_PORT, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
