FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY . .
RUN (pnpm install --frozen-lockfile || pnpm install --frozen-lockfile --registry=https://registry.npmjs.org/) \
 && REVIEWED_BUILD_ONLY=1 node scripts/prepare-reviewed-runtime.cjs \
 && REVIEWED_RUNTIME_ONLY=1 NEXT_TELEMETRY_DISABLED=1 pnpm exec next build --webpack

FROM node:20-slim AS runtime
WORKDIR /app
ARG BUILD_GIT_SHA
ENV NODE_ENV=production REVIEWED_RUNTIME_ONLY=1 NEXT_TELEMETRY_DISABLED=1 \
    MALLOC_ARENA_MAX=2 MALLOC_TRIM_THRESHOLD_=131072 BUILD_GIT_SHA=${BUILD_GIT_SHA}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-lxml python3-pil \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/ops/plan-b ./ops/plan-b
RUN node -e "require('sharp'); console.log('sharp runtime available')"
EXPOSE 3000
CMD ["sh", "-c", "PORT=${DEPLOY_RUN_PORT:-${PORT:-3000}} exec node server.js"]
