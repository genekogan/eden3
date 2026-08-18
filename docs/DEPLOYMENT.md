# Deployment notes

Eden3 does not ship a production deployment claim. `infra/docker-compose.yml` is a reference topology for an operator who understands its trust boundaries.

A deployment must provide:

- a maintained PostgreSQL service with backups and recovery testing
- TLS termination and a reverse proxy configured for the web and API origins
- a persistent, backed-up workspace/media store
- a separately secured OpenClaw gateway built from the pinned image or an independently reviewed equivalent
- secret injection that does not place credentials in images, source control, command-line arguments, or public logs
- provider-specific sandbox/test accounts during evaluation
- monitoring, rate limits, abuse controls, data retention, and incident response appropriate to the deployment

Before exposing an instance publicly, disable dev routes, review every optional integration, rotate bootstrap credentials, restrict network access, and perform an independent threat model. The included Compose file is not a substitute for that work.
