# Security and privacy

## Reporting

This is an early prototype. Do not include credentials, personal data, or exploit details in a public issue. Contact the repository owner privately for sensitive reports.

## Repository policy

- `.env*` files are ignored except `.env.example`.
- Runtime directories, logs, test evidence, browser artifacts, generated media, and database dumps must remain untracked.
- Configuration examples use placeholders and loopback addresses only.
- `pnpm test:credential-exposure` scans tracked files for common credential patterns and secret-like filenames. It complements, but does not replace, human review and provider-side secret scanning.

## Deployment warning

Development impersonation, test billing, permissive provider accounts, and the reference container topology are unsafe defaults for an internet-facing service. A production deployment requires independent authentication, authorization, network, dependency, data-lifecycle, and operational review.
