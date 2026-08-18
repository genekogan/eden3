#!/usr/bin/env bash
set -euo pipefail

# Docker Desktop/Colima exposes the host-backed OpenClaw data directory as
# SSHFS. OpenClaw correctly refuses to open SQLite there because file locking
# is not safe across that mount. Keep only the per-agent memory-search index in
# the existing VM-native `oc_state` volume and leave every canonical workspace,
# session transcript, and config file on the host-visible data mount.
prepare_agent_memory_indexes() {
  local index_root='/home/node/.openclaw/state/agent-memory'
  local agents_root='/home/node/.openclaw/agents'
  local agent_dir agent_id source target current_target backup link_needed

  install -d -o node -g node -m 0755 "$index_root"
  [ -d "$agents_root" ] || return 0

  shopt -s nullglob
  for agent_dir in "$agents_root"/*/agent; do
    [ -d "$agent_dir" ] || continue
    agent_id="$(basename "$(dirname "$agent_dir")")"
    if [[ ! "$agent_id" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
      echo "invalid agent directory while preparing memory index: $agent_id" >&2
      return 1
    fi

    source="$agent_dir/openclaw-agent.sqlite"
    target="$index_root/$agent_id.sqlite"
    link_needed=1
    if [ -L "$source" ]; then
      current_target="$(readlink "$source")"
      if [ "$current_target" != "$target" ]; then
        echo "unexpected memory-index symlink for $agent_id: $current_target" >&2
        return 1
      fi
      link_needed=0
    elif [ -e "$source" ]; then
      if [ ! -f "$source" ]; then
        echo "memory-index path is not a regular file for $agent_id" >&2
        return 1
      fi
      if [ -s "$source" ]; then
        if [ -e "$target" ]; then
          echo "refusing conflicting memory-index migration for $agent_id" >&2
          return 1
        fi
        backup="$source.sshfs-backup"
        if [ -e "$backup" ]; then
          echo "memory-index backup already exists for $agent_id" >&2
          return 1
        fi
        cp -p "$source" "$target"
        chown node:node "$target"
        mv "$source" "$backup"
      else
        rm "$source"
      fi
    fi

    if [ ! -e "$target" ]; then
      install -o node -g node -m 0644 /dev/null "$target"
    fi
    if [ "$link_needed" -eq 1 ]; then
      ln -s "$target" "$source"
    fi
  done
}

prepare_agent_memory_indexes

# One unlogged identity per gateway process lifetime. The resolver challenge
# binds each authenticated request to this instance; restarts cannot replay a
# captured request from the preceding process.
export EDEN_CHANNEL_REQUESTER_INSTANCE_ID
EDEN_CHANNEL_REQUESTER_INSTANCE_ID="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"

if [ -S /var/run/docker.sock ]; then
  docker_gid="$(stat -c '%g' /var/run/docker.sock)"
  if ! getent group "${docker_gid}" >/dev/null; then
    groupadd --gid "${docker_gid}" dockerhost
  fi
  usermod -aG "${docker_gid}" node
fi

exec runuser -u node -- "$@"
