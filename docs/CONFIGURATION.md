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

## Public URLs and reverse proxies

Set `NEXT_PUBLIC_API_ORIGIN`, `API_INTERNAL_URL`, Clerk authorized parties, billing return URLs, and media/object-store origins to values you control. Do not reuse the sample loopback values in a deployment.
