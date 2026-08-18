# syntax=docker/dockerfile:1.7

# Eden3 owns this thin derivative; the upstream base remains the
# OpenClaw-provided sandbox image and must be supplied by the operator.
FROM openclaw-sandbox:bookworm-slim

USER root

ENV DEBIAN_FRONTEND=noninteractive

ARG MEDIA_APT_PACKAGES="ffmpeg python3-pip python3-dev"
ARG MEDIA_PIP_PACKAGES="pillow numpy moviepy imageio imageio-ffmpeg requests"
ARG MEDIA_CACHE_BUST=1

RUN echo "media-cache-bust=${MEDIA_CACHE_BUST}" \
  && apt-get update \
  && apt-get install -y --no-install-recommends ${MEDIA_APT_PACKAGES} \
  && rm -rf /var/lib/apt/lists/*

# Debian bookworm marks system Python as externally managed. These libraries
# are ambient sandbox capabilities, so install them system-wide: agents and
# skills can use bare `python3` without activating a venv.
RUN python3 -m pip install \
  --no-cache-dir \
  --break-system-packages \
  ${MEDIA_PIP_PACKAGES} \
  && ln -sf /usr/bin/pip3 /usr/local/bin/pip \
  && python3 -c "import PIL, imageio, moviepy, numpy, requests" \
  && ffmpeg -version >/dev/null \
  && pip --version

# The runtime rootfs is read-only. Plain `pip install <package>` therefore
# targets a persistent, executable user base inside the writable agent
# workspace. Downloads still traverse HTTPS_PROXY from config-gen.
ENV PYTHONUSERBASE=/workspace/.python \
  PIP_USER=1 \
  PIP_BREAK_SYSTEM_PACKAGES=1 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PIP_NO_CACHE_DIR=1 \
  PATH=/workspace/.python/bin:${PATH}

USER sandbox
