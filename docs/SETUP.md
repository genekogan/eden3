# Local setup

## Prerequisites

- Node.js 22 or newer
- Corepack and pnpm 10.27.0
- PostgreSQL 16 or newer
- Docker with Compose only if using the reference container stack or OpenClaw image
- FFmpeg/ffprobe for voice and media features

## Install

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Create a disposable PostgreSQL database and update `DATABASE_URL` and `EDEN3_DATABASE_NAME` together. Never test migrations against an existing deployment.

```bash
pnpm db:migrate
pnpm dev
```

The API and web app run together. Verify the API with `curl http://127.0.0.1:4301/health` and open `http://127.0.0.1:4300`.

## Authentication profiles

For a local-only prototype, set `AUTH_PROVIDER=dev` and `EDEN3_DEV_ROUTES=1`. For real sign-in, set `AUTH_PROVIDER=clerk`, disable development routes, and supply your own Clerk keys and authorized origins. See [Configuration](CONFIGURATION.md).

## Real chat responses

Chat requires a reachable OpenClaw gateway plus at least one provider configured in that gateway. The Eden3 process receives only `OPENCLAW_BASE_URL` and `OPENCLAW_GATEWAY_TOKEN`; provider keys belong in the operator-owned OpenClaw environment and must not be committed.
