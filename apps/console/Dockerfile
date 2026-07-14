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
COPY apps/gateway/package.json apps/gateway/
COPY apps/agent-service/package.json apps/agent-service/
COPY apps/console/package.json apps/console/
RUN yarn install --immutable

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn turbo build --filter=@repo/console

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/console/dist /usr/share/nginx/html
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
