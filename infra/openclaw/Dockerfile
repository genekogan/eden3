FROM ghcr.io/openclaw/openclaw:2026.7.1@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c

USER root

ARG TARGETARCH
ARG EDEN3_NODE_VERSION=22.22.3
# Static Docker CLI, NOT Debian's docker.io: bookworm's client speaks at most
# API 1.41, which newer Docker daemons may reject. The daemon-side of
# docker.io is unnecessary here; only the client talks to an operator-owned
# Docker API boundary.
ARG EDEN3_DOCKER_CLI_VERSION=27.5.1
ARG EDEN3_DOCKER_CLIENT_API=1.47
RUN set -eux; \
  case "${TARGETARCH}" in \
    arm64) node_arch='arm64'; node_sha='1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7'; docker_arch='aarch64' ;; \
    amd64) node_arch='x64'; node_sha='2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f'; docker_arch='x86_64' ;; \
    *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  apt-get update; \
  apt-get install -y --no-install-recommends xz-utils; \
  install -d -m 0755 /usr/lib/eden3; \
  curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${EDEN3_DOCKER_CLI_VERSION}.tgz" \
    | tar -xz -C /tmp docker/docker; \
  install -m 0755 /tmp/docker/docker /usr/lib/eden3/docker-real; \
  client_api="$(DOCKER_HOST=tcp://127.0.0.1:1 /usr/lib/eden3/docker-real version --format '{{.Client.APIVersion}}' 2>/dev/null || true)"; \
  test "$client_api" = "${EDEN3_DOCKER_CLIENT_API}"; \
  rm -rf /tmp/docker; \
  archive="node-v${EDEN3_NODE_VERSION}-linux-${node_arch}.tar.xz"; \
  curl -fsSLO "https://nodejs.org/dist/v${EDEN3_NODE_VERSION}/${archive}"; \
  echo "${node_sha}  ${archive}" | sha256sum -c -; \
  tar -xJf "${archive}" --strip-components=1 -C /usr/local; \
  rm "${archive}"; \
  rm -rf /var/lib/apt/lists/*; \
  test "$(node --version)" = "v${EDEN3_NODE_VERSION}"

LABEL org.opencontainers.image.version="2026.7.1" \
  eden3.openclaw.docker-cli-version="${EDEN3_DOCKER_CLI_VERSION}" \
  eden3.openclaw.docker-client-api="${EDEN3_DOCKER_CLIENT_API}"

COPY docker-entrypoint.sh /usr/local/bin/eden3-openclaw-entrypoint
COPY docker-cli-wrapper.sh /usr/local/bin/docker
COPY --chown=node:node eden-channel-secret-resolver.mjs /usr/local/bin/eden-channel-secret-resolver
COPY patch-message-sent-run-id.mjs /usr/local/lib/eden3/patch-message-sent-run-id.mjs
COPY patch-channel-inbound-trust.mjs /usr/local/lib/eden3/patch-channel-inbound-trust.mjs
COPY patch-discord-reconnect-retention.mjs /usr/local/lib/eden3/patch-discord-reconnect-retention.mjs
COPY discord-reconnect-drain.mjs /usr/local/lib/eden3/discord-reconnect-drain.mjs
COPY patch-session-admission-consistency.mjs /usr/local/lib/eden3/patch-session-admission-consistency.mjs
COPY session-admission-policy.mjs /usr/local/lib/eden3/session-admission-policy.mjs
COPY patch-sqlite-symlink-storage.mjs /usr/local/lib/eden3/patch-sqlite-symlink-storage.mjs
COPY patch-channel-secret-requester.mjs /usr/local/lib/eden3/patch-channel-secret-requester.mjs
COPY channel-secret-requester-origin.mjs /usr/local/lib/eden3/channel-secret-requester-origin.mjs
COPY patch-channel-secret-error-redaction.mjs /usr/local/lib/eden3/patch-channel-secret-error-redaction.mjs
COPY --chown=node:node plugins/eden3-cron /opt/eden3/openclaw-plugins/eden3-cron
COPY --chown=node:node plugins/eden3-channel-runtime /opt/eden3/openclaw-plugins/eden3-channel-runtime
RUN cd /opt/eden3/openclaw-plugins/eden3-cron \
  && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && chown -R node:node /opt/eden3/openclaw-plugins/eden3-cron
RUN node /usr/local/lib/eden3/patch-message-sent-run-id.mjs \
  && rm /usr/local/lib/eden3/patch-message-sent-run-id.mjs
RUN node /usr/local/lib/eden3/patch-channel-inbound-trust.mjs \
  && rm /usr/local/lib/eden3/patch-channel-inbound-trust.mjs
RUN node /usr/local/lib/eden3/patch-discord-reconnect-retention.mjs \
  && rm \
      /usr/local/lib/eden3/patch-discord-reconnect-retention.mjs \
      /usr/local/lib/eden3/discord-reconnect-drain.mjs
RUN node /usr/local/lib/eden3/patch-session-admission-consistency.mjs \
  && rm \
      /usr/local/lib/eden3/patch-session-admission-consistency.mjs \
      /usr/local/lib/eden3/session-admission-policy.mjs
RUN node /usr/local/lib/eden3/patch-sqlite-symlink-storage.mjs \
  && rm /usr/local/lib/eden3/patch-sqlite-symlink-storage.mjs
RUN node /usr/local/lib/eden3/patch-channel-secret-requester.mjs \
  && rm \
      /usr/local/lib/eden3/patch-channel-secret-requester.mjs \
      /usr/local/lib/eden3/channel-secret-requester-origin.mjs
RUN node /usr/local/lib/eden3/patch-channel-secret-error-redaction.mjs \
  && rm /usr/local/lib/eden3/patch-channel-secret-error-redaction.mjs
RUN chmod 0755 \
      /usr/local/bin/eden3-openclaw-entrypoint \
      /usr/local/bin/docker \
      /usr/local/bin/eden-channel-secret-resolver

ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/eden3-openclaw-entrypoint"]
CMD ["node", "openclaw.mjs", "gateway"]
