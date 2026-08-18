# Branch reconciliation for the public checkpoint

The public checkpoint was curated from `codex/review-readiness-12h`, which was a direct 56-commit successor of the former local `main`.

Local heads were classified by ancestry and patch identity rather than merged indiscriminately. Forty-nine heads were already ancestors and thirty-eight were patch-equivalent to changes in the reviewed checkpoint. Eleven heads had unique patch IDs whose contents were not integrated into the final working tree:

- `blast/channels`, `blast/channels-a-runtime`, and `blast/channels-c-connectors`: older partial channel/runtime work superseded by the reviewed channel implementation.
- `blast/dream-recovery-auth`: an isolated earlier recovery fix superseded by the reviewed recovery and authentication work.
- `blast/storage-data`: older partial storage/share lifecycle work superseded by the reviewed storage implementation.
- `blast/task1-cockpit` and `blast/task1-ontology`: earlier UI/ontology experiments superseded by the current application.
- `codex/m3-ceremony-operator`: internal review-stack operational machinery, intentionally excluded from the public prototype tree.
- `codex/voice-backend` and `codex/voice-provider-free-e2e`: earlier voice slices superseded by the reviewed voice implementation.
- `rescue/privy-demo-2026-07-11`: an obsolete Privy prototype; the current application uses Clerk or local development authentication.

## Historical publication

The public `main` history retains all 1,282 pre-publication commits. Historical development heads are represented as parents of the sanitized checkpoint so their commit ancestry remains reachable without publishing dozens of active branch refs. Their divergent contents are historical evidence, not claims that those implementations are present in the final tree.

Every historical commit was rewritten before publication:

- author and committer identity are normalized to the project owner;
- original author and committer timestamps are preserved;
- credential-bearing, personal, private-infrastructure, runtime-evidence, migration, and third-party research paths are removed from historical trees;
- sensitive commit-message coordinates and co-author email trailers are redacted;
- commits made empty by sanitization remain in the graph.

Only the public-safe `main` ref is published. The working tree at its tip is the reviewed prototype checkpoint described by the rest of this documentation.
