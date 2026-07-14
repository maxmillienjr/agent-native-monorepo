FROM node:26-alpine AS base
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/agent-contracts/package.json packages/agent-contracts/
COPY packages/memory-core/package.json packages/memory-core/
COPY apps/agent-service/package.json apps/agent-service/
COPY apps/gateway/package.json apps/gateway/
COPY apps/console/package.json apps/console/
RUN yarn install --immutable

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn turbo build --filter=@repo/agent-service

FROM base AS runner
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001
COPY --from=builder --chown=nestjs:nodejs /app/apps/agent-service/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
USER nestjs
EXPOSE 3000
CMD ["node", "dist/main.js"]
