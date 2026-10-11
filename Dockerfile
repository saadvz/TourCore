# Railway auto-detection for the isolated cleaner-core/railway-agent-proof branch.
# Keep these build steps aligned with Dockerfile.cleaner-test.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# An optional CA mount is only for verifying builds behind a workspace proxy.
# Railway builds normally have no mount and use the image's standard trust store.
RUN --mount=type=secret,id=workspace_ca \
    if [ -f /run/secrets/workspace_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/workspace_ca; fi; \
    npm ci --no-audit --no-fund
COPY src/delegation/ src/delegation/
COPY src/storage/atomicWrite.ts src/storage/atomicWrite.ts
COPY scripts/serve-delegation.ts scripts/serve-delegation.ts
RUN ./node_modules/.bin/esbuild scripts/serve-delegation.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/cleaner-test-server.mjs
RUN --mount=type=secret,id=workspace_ca \
    if [ -f /run/secrets/workspace_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/workspace_ca; fi; \
    npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
# flock releases the single-writer lock even when a container is killed.
RUN command -v flock && command -v mountpoint
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
COPY scripts/start-cleaner-test-container.sh scripts/start-cleaner-test-container.sh
ENV NODE_ENV=production CLEANER_TEST_HOME=/data/cleaner-core-test CLEANER_TEST_HOST=0.0.0.0
ENTRYPOINT ["sh", "scripts/start-cleaner-test-container.sh"]
