# Eden3

Eden3 is an open-source, self-hostable prototype for creating and interacting with persistent AI agents. It combines a Next.js application, a Fastify API, PostgreSQL-backed state, and an external OpenClaw gateway integration.

> **Project status:** working prototype / in-progress checkpoint. This repository is not production-ready, public-launch-ready, or approved for migration from Eden1 or any other existing deployment. Expect incomplete integrations and breaking changes.

## What is included

- agent creation, profiles, persona/workspace management, memory, chat, and sharing
- authentication adapters for local development and Clerk
- metering and optional Stripe test-mode billing
- optional media, transcription, voice, object storage, and channel integrations
- PostgreSQL schema and migrations
- an OpenClaw integration image built from an external digest-pinned upstream image

The complete upstream OpenClaw source is **not** vendored in this repository. See [OpenClaw integration](docs/OPENCLAW.md).

## Quick start

Requirements: Node.js 22+, pnpm 10.27.0, PostgreSQL 16+, and optionally Docker with Compose.

```bash
git clone <your-fork-url>
cd eden3
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
# Edit .env.local with your own local values.
pnpm db:migrate
pnpm dev
```

The web app defaults to `http://127.0.0.1:4300` and the API to `http://127.0.0.1:4301`. The minimal local profile uses development authentication and a local PostgreSQL database. Real AI responses require an OpenClaw gateway configured with your own provider credentials.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Local setup](docs/SETUP.md)
- [Configuration](docs/CONFIGURATION.md)
- [Testing](docs/TESTING.md)
- [Deployment notes](docs/DEPLOYMENT.md)
- [OpenClaw integration](docs/OPENCLAW.md)
- [Security and privacy](docs/SECURITY.md)
- [Known limitations](docs/LIMITATIONS.md)
- [Branch reconciliation](docs/BRANCH-RECONCILIATION.md)

## License

MIT. See [LICENSE](LICENSE).
