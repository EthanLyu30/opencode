FROM oven/bun@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0

USER root

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/local/bin/bun /usr/local/bin/node \
  && mkdir -p /workspace /opencode/tmp /home/sandbox \
  && chown 65532:65532 /workspace /opencode/tmp /home/sandbox \
  && git config --system --add safe.directory /workspace

COPY --chmod=0555 opencode-preview-supervisor.ts /usr/local/bin/opencode-preview-supervisor
COPY --chmod=0555 opencode-preview-ingress.ts /usr/local/bin/opencode-preview-ingress

USER 65532:65532
WORKDIR /workspace
