# Optional media sandbox

This image extends the operator-supplied `openclaw-sandbox:bookworm-slim` image with FFmpeg and common Python media libraries.

```bash
docker image inspect openclaw-sandbox:bookworm-slim
docker build -t eden3-openclaw-sandbox-media:2026.7.1 infra/openclaw/sandbox-media
```

Review and pin the upstream sandbox image before use. Eden3 does not vendor that upstream image or source. Configure OpenClaw to select this derivative only for agents that need its additional capabilities.
