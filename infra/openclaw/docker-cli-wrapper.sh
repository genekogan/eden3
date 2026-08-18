#!/usr/bin/env bash
set -euo pipefail

readonly REAL_DOCKER=/usr/lib/eden3/docker-real
readonly INIT_LOCK=/tmp/eden3-docker-sandbox-init.lock

apply_sandbox_oom_priority() {
  local -a args=("$@")
  local index
  local is_sandbox=0
  for ((index = 0; index < ${#args[@]}; index += 1)); do
    if [[ "${args[index]}" == 'openclaw.sandbox=1' ]]; then
      is_sandbox=1
      break
    fi
  done
  if ((is_sandbox == 1)); then
    # Dynamic sandboxes are disposable and must lose an OOM race before the
    # gateway or either durable database. OpenClaw supplies its memory/PID caps
    # in the generated config; this wrapper owns only the kernel preference.
    SANDBOX_DOCKER_ARGS=("${args[0]}" --oom-score-adj 1000 "${args[@]:1}")
  else
    SANDBOX_DOCKER_ARGS=("${args[@]}")
  fi
}

# OpenClaw 7.1 creates a writable workspace bind plus nested read-only skill
# binds for each sandbox. Concurrent OCI initialization of those nested mounts
# races on macOS Docker hosts. Serialize only container initialization; Docker
# reads, execs, logs, and cleanup remain fully concurrent.
case "${1:-}" in
  create|run)
    apply_sandbox_oom_priority "$@"
    exec /usr/bin/flock --exclusive "${INIT_LOCK}" "${REAL_DOCKER}" "${SANDBOX_DOCKER_ARGS[@]}"
    ;;
  start)
    exec /usr/bin/flock --exclusive "${INIT_LOCK}" "${REAL_DOCKER}" "$@"
    ;;
  *)
    exec "${REAL_DOCKER}" "$@"
    ;;
esac
