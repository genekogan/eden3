# Contributor and agent guide

Eden3 is a working prototype and in-progress checkpoint. It is not production-ready, public-launch-ready, or approved for migration from an earlier Eden installation.

Read these files before making changes:

1. `README.md` — project status and quick start.
2. `docs/ARCHITECTURE.md` — system boundaries and repository map.
3. `docs/SETUP.md` — local prerequisites and setup.
4. `docs/CONFIGURATION.md` — runtime configuration and credentials.
5. `docs/TESTING.md` — validation commands and test boundaries.
6. `docs/LIMITATIONS.md` — known gaps and non-claims.

## Working rules

- Never commit `.env`, credentials, runtime data, logs, test artifacts, or provider responses.
- Add new configuration through environment variables and document it in `.env.example`.
- Keep local development on disposable data. Do not point tests or migrations at an existing deployment.
- Treat `infra/openclaw/Dockerfile` as an integration layer over an external, digest-pinned OpenClaw image. The upstream OpenClaw source is not vendored here.
- Keep changes scoped and add the smallest relevant test. Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before handing off broad changes.
- Do not claim production readiness from a passing local test suite.

## Repository map

| Path | Purpose |
|---|---|
| `apps/api` | Fastify API, authentication, chat, billing, media, and operational endpoints |
| `apps/web` | Next.js application |
| `packages/core` | Configuration, metering, and shared domain services |
| `packages/db` | PostgreSQL schema and migrations |
| `packages/gateway` | OpenClaw provisioning and compatibility layer |
| `packages/shared` | Shared types and utilities |
| `infra` | Prototype container and sidecar definitions |
| `scripts` | Generic local helpers and repository scanners |
| `docs` | Public architecture, setup, testing, and limitations |

## Security boundary

The repository contains code paths for third-party AI, authentication, billing, storage, and channel providers. They are opt-in and must use credentials supplied by the operator. Never add personal account identifiers, private hosts, fixed external project IDs, or real credentials to source or documentation.
