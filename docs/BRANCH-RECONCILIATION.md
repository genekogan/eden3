# Branch reconciliation for the public checkpoint

The public checkpoint was curated from `codex/review-readiness-12h`, which was a direct 56-commit successor of the former local `main`.

Local heads were classified by ancestry and patch identity rather than merged indiscriminately. Forty-nine heads were already ancestors and thirty-eight were patch-equivalent to changes in the reviewed checkpoint. Eleven heads had unique patch IDs but were not integrated:

- `blast/channels`, `blast/channels-a-runtime`, and `blast/channels-c-connectors`: older partial channel/runtime work superseded by the reviewed channel implementation.
- `blast/dream-recovery-auth`: an isolated earlier recovery fix superseded by the reviewed recovery and authentication work.
- `blast/storage-data`: older partial storage/share lifecycle work superseded by the reviewed storage implementation.
- `blast/task1-cockpit` and `blast/task1-ontology`: earlier UI/ontology experiments superseded by the current application.
- `codex/m3-ceremony-operator`: internal review-stack operational machinery, intentionally excluded from the public prototype.
- `codex/voice-backend` and `codex/voice-provider-free-e2e`: earlier voice slices superseded by the reviewed voice implementation.
- `rescue/privy-demo-2026-07-11`: an obsolete Privy prototype; the current application uses Clerk or local development authentication.

The public branch is an intentionally sanitized snapshot. Private development branches and runtime evidence were not pushed.
