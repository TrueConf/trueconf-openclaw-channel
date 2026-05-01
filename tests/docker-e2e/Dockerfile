FROM node:22-bookworm-slim
WORKDIR /app

# curl is used by the e2e driver via `docker exec` against the fake-server
# container to read /control/state without paying for an extra sidecar pull.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy package manifests first so npm ci layer caches across rebuilds when
# only sources changed. The image is built from the repo root so paths are
# relative to the build context.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# tsx is the lightest runtime TS loader for ad-hoc scripts; vitest is too
# heavy for a long-running daemon and node --strip-types is still
# experimental in 22.x.
RUN npm install --global --no-audit --no-fund tsx@4.19.2

COPY src ./src
COPY tests ./tests
COPY tsconfig.json ./

# Default CMD is overridden per-service in compose.yaml.
CMD ["tsx", "tests/docker-e2e/fake-server-bin.ts"]
