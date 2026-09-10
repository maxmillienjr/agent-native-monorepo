FROM node:24-alpine AS base
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app

# The workspaces this image needs are derived, not listed. `turbo prune` walks the
# dependency graph and emits a pruned lockfile plus every package.json the graph
# reaches, at its real path. The hand-maintained COPY list this replaces broke the
# image once per new workspace — the dependency was in package.json and the
# workspace was not, so `yarn install` failed with "Workspace not found".
# Pinned to the root devDependency; `--docker` is what splits json/ from full/.
FROM base AS pruner
RUN npm install -g turbo@2.10.11
COPY . .
RUN turbo prune @repo/agent-service --docker

# json/ is manifests and lockfile only, so this layer is cached until a
# dependency actually changes rather than on every source edit.
FROM base AS deps
COPY --from=pruner /app/out/json/ ./
RUN yarn install --immutable

# Built from deps, not base: yarn needs the pruned lockfile, .yarnrc.yml and
# .yarn/releases at the root to run at all, and those already landed there.
FROM deps AS builder
COPY --from=pruner /app/out/full/ ./
RUN yarn turbo build --filter=@repo/agent-service

FROM base AS runner
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001
COPY --from=builder --chown=nestjs:nodejs /app/apps/agent-service/dist ./dist
# node_modules/@repo/* are symlinks into ../../packages, so the packages tree has
# to land at the same relative path or every workspace import resolves to nothing:
# "Cannot find package '@repo/telemetry' imported from /app/dist/main.js".
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/packages ./packages
USER nestjs
EXPOSE 3000
CMD ["node", "dist/main.js"]
