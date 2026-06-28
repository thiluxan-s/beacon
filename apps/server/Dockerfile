# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---- runner: tsx runtime ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=deps /app/node_modules ./node_modules
# Server source + shared package (raw TS, run via tsx) + migrations.
COPY package.json package-lock.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 hono \
 && chown -R hono:nodejs /app
USER hono
EXPOSE 3001
# Run from the server workspace so drizzle paths (./drizzle) resolve and tsx finds src.
WORKDIR /app/apps/server
CMD ["npm", "run", "start"]
