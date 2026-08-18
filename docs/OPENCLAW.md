# OpenClaw integration

Eden3 integrates with [OpenClaw](https://github.com/openclaw/openclaw) as an external runtime. The upstream source is not copied into this repository.

`infra/openclaw/Dockerfile` starts from an upstream image identified by both a version tag and a content digest, then applies Eden3-specific integration files. A digest pin makes the selected image reproducible; it does not transfer ownership, licensing, maintenance, or security guarantees from upstream.

Before building, inspect the current upstream project and license, verify that the digest is still the one intended for your architecture, and review the local patches. Provide gateway and model-provider credentials only at runtime using your own secret-management mechanism.

## Build versus run

The reference Compose profile builds the integration image but deliberately does not claim to provide a production gateway deployment:

```bash
node scripts/compose.mjs --profile openclaw-build build openclaw-image
```

A real gateway operator must additionally provide a private, persistent OpenClaw data directory, a persistent home for the container's `node` user, the gateway token, the reviewed Docker/egress boundaries required by the selected features, and an independent backup/upgrade policy. `OPENCLAW_BASE_URL` and `OPENCLAW_GATEWAY_TOKEN` then point Eden3 at that gateway.

## Using a Claude subscription

This checkpoint includes an actual subscription-backed runtime for Claude Code. It is not configured with `ANTHROPIC_API_KEY`. Instead, Claude Code is installed and authenticated once as the OpenClaw container's `node` user, inside an operator-owned persistent home.

For a running gateway container, replace `<openclaw-container>` below with its exact container name:

```bash
docker exec -it -u node <openclaw-container> sh -lc \
  'curl -fsSL https://claude.ai/install.sh | bash'
docker exec -it -u node <openclaw-container> \
  /home/node/.local/bin/claude --version
docker exec -it -u node <openclaw-container> \
  /home/node/.local/bin/claude
```

Complete Claude's interactive browser login with the operator's own eligible Claude subscription, then exit the interactive client. Anthropic's current setup guide describes Claude subscription and API-billed login as separate choices: [Set up Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started).

Operational requirements:

- persist the `node` user's home across gateway recreation; the configured command is `/home/node/.local/bin/claude`
- authenticate independently on each operator-controlled machine; never commit, publish, or copy the resulting credential files into the repository or `.env.local`
- use **Operator → Model runtimes** to switch an eligible Anthropic model from `openclaw` to `claude-cli`
- expect a missing, expired, or unavailable CLI login to fail the turn visibly and trigger Eden3's refund path; there is deliberately no hidden API fallback
- review Anthropic's current plan eligibility, usage limits, terms, and data handling before relying on this mode

Eden3's internal manna accounting still records subscription-backed turns at API-equivalent notional rates. That bookkeeping does not mean Anthropic separately billed the request through its API.

## Codex subscriptions are not wired yet

OpenAI's Codex CLI supports `codex login` with ChatGPT for subscription access as well as API-key login for usage-based access: [OpenAI authentication](https://learn.chatgpt.com/docs/auth). That capability belongs to the Codex client; it does not automatically make Codex a backend for another application.

Eden3 currently has no `codex-cli` backend, Codex model-runtime option, transcript usage adapter, or settlement path. Therefore there is no supported configuration that makes Eden3 chat consume a ChatGPT/Codex subscription today. `OPENAI_API_KEY` remains ordinary OpenAI Platform API access with separate usage-based billing.

Adding subscription-backed Codex would require an explicit, reviewed implementation across the OpenClaw CLI backend, model catalog, failure/refund behavior, transcript usage capture, concurrency fencing, operator controls, and tests. It should not be approximated by mounting or copying a developer's Codex credential directory into the gateway.
