# Browser smoke testing

The browser smoke test expects an already-running disposable instance and does not create accounts or provider resources.

```bash
E2E_WEB_URL=http://127.0.0.1:4300 pnpm exec playwright test
```

The test proves only that the web shell loads without a fatal browser error. Product journeys requiring authentication, provider credentials, billing, channels, microphone access, or generated media must be tested separately with operator-owned sandbox accounts.
