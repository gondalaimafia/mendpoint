# Mendpoint / Warden GA — multi-stage production image (API)
# Build: docker build -t mendpoint-api:1.0.0 .
# Run:   docker run -p 3001:3001 -e API_AUTH=required -e NODE_ENV=production -v mendpoint-data:/app/data mendpoint-api:1.0.0

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY tsconfig.base.json ./
# Install workspace deps (API + packages)
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3001
ENV API_AUTH=required
ENV GITHUB_MODE=mock
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app /app
COPY schema ./schema
COPY fixtures ./fixtures
COPY scripts ./scripts
RUN mkdir -p /app/data /app/runs
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["npx", "tsx", "apps/api/src/server.ts"]
