FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY . .
RUN (pnpm install --frozen-lockfile || pnpm install --frozen-lockfile --registry=https://registry.npmjs.org/) \
 && REVIEWED_BUILD_ONLY=1 node scripts/prepare-reviewed-runtime.cjs \
 && REVIEWED_RUNTIME_ONLY=1 NEXT_TELEMETRY_DISABLED=1 pnpm exec next build --webpack

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production REVIEWED_RUNTIME_ONLY=1 NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
RUN node -e "require('sharp'); console.log('sharp runtime available')"
EXPOSE 3000
CMD ["sh", "-c", "PORT=${DEPLOY_RUN_PORT:-${PORT:-3000}} exec node server.js"]
