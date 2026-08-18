# Developer handoff

Hey — this repository is the current Eden3 working prototype, not a production release or an Eden1 migration package. To reproduce it on your computer, start with [README](../README.md), then follow [Local setup](SETUP.md) and [Configuration](CONFIGURATION.md). Those three files are the normal onboarding path; read [Architecture](ARCHITECTURE.md) before changing system boundaries and [OpenClaw integration](OPENCLAW.md) before enabling real chat.

Use a fresh clone, a disposable PostgreSQL database, and credentials from accounts you control. Copy `.env.example` to `.env.local`; never ask for or reuse another developer's `.env`, database, Clerk tenant, bot tokens, provider keys, or Claude/Codex login files. Telegram and Discord credentials are per connected bot, not global application tokens.

The shortest local sequence is:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
# Fill in your own disposable database and loopback settings.
pnpm db:migrate
pnpm dev
```

That starts the web/API prototype. Real responses additionally require your own OpenClaw gateway. You may configure provider API keys in that gateway, or use the documented Claude Code subscription backend. A ChatGPT/Codex subscription cannot currently power Eden3 chat without new integration work.

Before handing your clone onward, run:

```bash
pnpm typecheck
pnpm test
pnpm build
git status --short
```

The expected final command prints nothing. Known gaps and non-claims are listed in [Known limitations](LIMITATIONS.md).
