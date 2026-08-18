# Testing

Run the repository-wide static and unit checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` includes the tracked-tree credential scanner. Integration tests require disposable infrastructure and are deliberately separate:

```bash
pnpm --filter @eden3/db test:integration
pnpm --filter @eden3/api test:postgres
pnpm --filter @eden3/gateway test:integration
```

Never point integration tests at a database, gateway, bucket, billing account, or identity tenant containing important data. Some provider-backed features need operator-supplied sandbox credentials and are not part of the default test run.

Before publishing changes, also inspect `git diff --check`, `git status`, and the staged diff. Test results establish only the exercised prototype behavior; they do not establish production readiness.
