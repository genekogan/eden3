# Known limitations

This checkpoint is intentionally labeled a working prototype.

- It is not an Eden1 migration release and contains no supported legacy-data migration path.
- It is not production- or public-launch-ready.
- OpenClaw and all AI providers are external dependencies with their own availability, privacy, cost, and licensing terms.
- Authentication, billing, channels, storage, media generation, transcription, and voice require operator-owned accounts and feature-specific validation.
- The reference Compose topology is for evaluation, not high availability or production hardening.
- Browser/device permission behavior, especially microphone access, depends on secure origins and user browser settings.
- Provider-backed and destructive integration tests are excluded from the default test run.
- APIs, schema, and configuration may change without backward compatibility.
