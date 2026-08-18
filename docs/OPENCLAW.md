# OpenClaw integration

Eden3 integrates with [OpenClaw](https://github.com/openclaw/openclaw) as an external runtime. The upstream source is not copied into this repository.

`infra/openclaw/Dockerfile` starts from an upstream image identified by both a version tag and a content digest, then applies Eden3-specific integration files. A digest pin makes the selected image reproducible; it does not transfer ownership, licensing, maintenance, or security guarantees from upstream.

Before building, inspect the current upstream project and license, verify that the digest is still the one intended for your architecture, and review the local patches. Provide gateway and model-provider credentials only at runtime using your own secret-management mechanism.
