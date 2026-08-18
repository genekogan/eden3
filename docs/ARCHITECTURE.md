# Architecture

Eden3 is a TypeScript monorepo managed with pnpm.

```text
Browser -> Next.js web -> Fastify API -> PostgreSQL
                                  |-> OpenClaw gateway -> operator-selected AI providers
                                  |-> optional storage, voice, billing, and channel providers
```

## Components

- `apps/web` renders the product UI and calls the API. Server-side web requests use `API_INTERNAL_URL`; browser requests use `NEXT_PUBLIC_API_ORIGIN`.
- `apps/api` owns authentication, authorization, business rules, chat orchestration, media, billing, and provider adapters.
- `packages/db` owns the PostgreSQL schema and forward migrations.
- `packages/core` owns configuration parsing, metering, and domain services shared by the API and supporting processes.
- `packages/gateway` provisions and synchronizes agent workspaces through OpenClaw.
- `packages/shared` contains dependency-light types and helpers.
- `infra` contains a prototype Compose topology and small least-privilege sidecars. It is a reference, not a production security blueprint.

## Data and trust boundaries

PostgreSQL is the system of record. Agent workspace files and generated media are operator-owned filesystem data. OpenClaw is a separately versioned external runtime. Optional third-party services receive only the data required for the enabled feature; operators are responsible for their providers' privacy terms.

Local development authentication is intentionally separate from Clerk authentication. Never enable development impersonation routes on a public deployment.
