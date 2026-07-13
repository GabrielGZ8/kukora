# ─── Build stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# Full install (incl. devDependencies) — vite and @vitejs/plugin-react live
# there (package.json correctly keeps them out of production deps), but the
# build itself needs them. Installing with --omit=dev here would make
# `npm run build` fail with "vite: not found".
RUN npm ci

COPY . .
RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Only production dependencies — this stage never runs vite, so --omit=dev
# is correct here (unlike the build stage above).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built assets and server
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY docs ./docs

# Run as a non-root, unprivileged user. node:20-alpine ships a pre-created
# `node` user (uid/gid 1000) for exactly this purpose — no need to create
# one manually. Ownership of /app is fixed up before dropping privileges.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- --header="x-internal-key: ${INTERNAL_API_KEY}" http://localhost:5000/health || exit 1

CMD ["node", "server/index.js"]
