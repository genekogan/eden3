# Configuration

Copy `.env.example` to `.env.local`. Values shown in the template are placeholders or safe loopback defaults. Supply all credentials at runtime; never commit the populated file.

## Required core values

- `DATABASE_URL`, `EDEN3_DATABASE_NAME`: one disposable PostgreSQL database.
- `OPENCLAW_BASE_URL`, `OPENCLAW_GATEWAY_TOKEN`: gateway endpoint and credential for chat/agent execution.
- `MEDIA_DIR`, `VOICE_OUTPUT_DIR`, `TRANSCRIPTION_AUDIO_DIR`: writable local directories outside source control.
- `CHANNEL_TOKEN_ENCRYPTION_KEY`: random 32-byte base64 key if channel credentials are enabled.

## Authentication

- `AUTH_PROVIDER=dev` is for local development only.
- `AUTH_PROVIDER=clerk` requires `CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and exact `CLERK_AUTHORIZED_PARTIES`.
- `EDEN3_DEV_ROUTES` must be unset or `0` anywhere reachable by untrusted users.

## Optional providers

Stripe, object storage, voice, transcription, media generation, and messaging channels are optional. Use only your own provider accounts and test/sandbox keys until you have completed an independent production review. Provider keys are intentionally blank in `.env.example`.

OpenClaw model-provider keys such as Anthropic, OpenAI, Gemini, or other supported providers should normally be injected into the OpenClaw runtime, not the web application.

## Messaging-channel credentials are per connection

Eden3 does not use one global Telegram, Discord, or Slack bot for every agent. Each supported Telegram or Discord connection is created from an agent's **Gateway** screen and has its own encrypted credential in `channel_connections`. The OpenClaw runtime receives only a connection-scoped secret capability when that named account is active.

The unnumbered `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` entries in `.env.example` are test-only placeholders for developer-authored single-bot/provider fixtures. The application does not use them as its hosted credential store. Leave them blank for normal development and deployment.

The optional `TELEGRAM_MANAGER_BOT_USERNAME`, `TELEGRAM_MANAGER_BOT_TOKEN`, and `TELEGRAM_MANAGER_WEBHOOK_SECRET` describe a different credential: one operator-owned manager bot that brokers the managed Telegram onboarding flow. It never replaces the separate token of each bot a user connects. Discord uses bring-your-own-bot onboarding. Hosted Slack connections are not implemented in this checkpoint.

`CHANNEL_TOKEN_ENCRYPTION_KEY` protects the per-connection credentials at rest. Generate a fresh 32-byte base64 value for each deployment, keep it outside source control, and treat losing or rotating it as a credential-custody operation rather than a routine config edit.

## API-backed and subscription-backed model runtimes

Eden3 currently supports two execution modes:

- `openclaw`: the gateway calls a configured model provider with operator-supplied API credentials. Provider billing applies.
- `claude-cli`: the gateway invokes Claude Code at `/home/node/.local/bin/claude`, authenticated by the operator's Claude subscription. Eden3 records usage with the `notional-subscription` pricing basis and does not silently fall back to an Anthropic API key.

The operator can choose the runtime for each supported Anthropic model from **Operator → Model runtimes**. See [OpenClaw integration](OPENCLAW.md#using-a-claude-subscription) for the persistent-home and login requirements.

Codex CLI itself can authenticate with a ChatGPT subscription, but Eden3 does **not** currently implement a `codex-cli` model backend, transcript adapter, or metering path. Do not paste Codex login data into `.env.local`. `OPENAI_API_KEY` configures separately billed OpenAI API access through OpenClaw; it does not draw from a ChatGPT/Codex subscription. See [OpenClaw integration](OPENCLAW.md#codex-subscriptions-are-not-wired-yet).

## Public URLs and reverse proxies

Set `NEXT_PUBLIC_API_ORIGIN`, `API_INTERNAL_URL`, Clerk authorized parties, billing return URLs, and media/object-store origins to values you control. Do not reuse the sample loopback values in a deployment.
