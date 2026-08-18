# Sandbox Docker guard

`sandbox-docker-guard@v1` is the sole Docker-socket holder for the shared
OpenClaw gateway. It listens on port 2375 only inside Compose's internal
`sandbox_control` network; it has no published port and never joins resolver,
database, sandbox, or general runtime networks.

The v1 contract is intentionally narrow:

- Docker API 1.44–1.47 ping/version and exact-image inspection;
- exact `openclaw-sbx-<bounded-session-slug>-<8hex>` container creation for
  `eden3-openclaw-sandbox-media:2026.7.1` on `eden3-sandbox-egress`;
- canonical per-agent workspace plus reviewed read-only skill/asset binds,
  read-only root, three non-executable tmpfs mounts, all capabilities dropped,
  no-new-privileges, and finite memory/PID limits;
- a guard-created unpredictable workspace sentinel, injected as the sandbox's
  inert start gate and exact healthcheck. Start is serialized against exec,
  re-attested, and failed closed with forced removal unless the exact mounted
  workspace exposes that sentinel and reaches healthy;
- independently re-attested inspect/start/stop/bounded-log/forced-remove calls,
  rewritten to the daemon-returned canonical container ID; and
- exec creation only on an attested sandbox, followed by start/inspect/resize
  only for the expiring exec ID returned through this guard instance. Exec
  streaming is the only permitted HTTP upgrade.

All list/copy/archive/build/pull/commit/image mutation/network/volume/plugin/
swarm/system/event endpoints fail closed. Sandbox-browser support is disabled
in the retained Eden baseline and is not part of v1.

Run the deterministic boundary proof without a Docker daemon:

```bash
node --test \
  infra/docker-socket-guard/server.test.mjs \
  infra/docker-socket-guard/compose-boundary.test.mjs
```

The suite includes a Unix-socket mock daemon and proves create postflight uses
the daemon-resolved mount source, image ID, and daemon-expanded security
projection; it also proves the start gate rejects a transient Running sample
and removes the container unless sentinel-backed health becomes ready. The guard's workspace-root mount is
writable only to create/remove these zero-byte sentinels. That is an accepted
trust expansion inside the already root-equivalent socket holder, not a general
workspace mutation interface.

Cutover requires a serialized stack lease: remove/recreate all disposable
`openclaw-sbx-*` containers when installing the guard. Pre-guard containers do
not carry the sentinel and are deliberately not reconstructed. Likewise, when
the pinned sandbox image is rebuilt under the same tag, remove old sandboxes
before switching the tag; immutable image-ID attestation intentionally refuses
their lifecycle operations. Never broaden delete/start attestation to work
around that fail-closed rotation ceremony.

A live image/daemon attacker probe is intentionally separate and requires the
serialized integration lease; never restore a raw socket mount to obtain it.
