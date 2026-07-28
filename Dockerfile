# Mendpoint / Warden GA production images
# API: docker build --target api -t mendpoint-api:1.0.0 .
# Web: docker build --target web -t mendpoint-web:1.0.0 .

FROM node:22-bookworm-slim AS api-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY tsconfig.base.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS web-build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npm run build -w @mendpoint/web

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3001
ENV API_AUTH=required
ENV GITHUB_MODE=mock
ENV MENDPOINT_DATA_DIR=/app/data
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=api-deps /app /app
COPY schema ./schema
COPY fixtures ./fixtures
COPY scripts ./scripts
RUN mkdir -p /app/data /app/runs /app/.mendpoint \
  && chown -R node:node /app/data /app/runs /app/.mendpoint
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
