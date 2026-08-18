#!/usr/bin/env bash
set -euo pipefail

# Preserve the caller's Docker context and configuration. Integration tests
# must never guess or rewrite a developer's local daemon settings.
exec "$@"
