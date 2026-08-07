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
COPY docs/PUBLIC_CLAIMS.json ./docs/PUBLIC_CLAIMS.json
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
COPY --chown=node:node apps/web/start-production.mjs ./start-production.mjs
USER node
EXPOSE 3000
CMD ["node", "start-production.mjs"]

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3001
ENV API_AUTH=required
ENV MENDPOINT_DATA_DIR=/app/data
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=api-deps /app /app
COPY schema ./schema
COPY fixtures ./fixtures
COPY scripts ./scripts
RUN mkdir -p /app/data/.backup-fence/writers /app/data/.backup-state \
    /app/data/warden-candidates /app/data/warden-evidence \
    /app/data/transformer-candidates /app/data/transformer-evidence \
    /app/runs /app/.mendpoint /workspace/repos /backup/mendpoint /restore \
  && chown -R node:node /app/data /app/runs /app/.mendpoint /workspace/repos /backup /restore \
  && chmod 700 /app/data/.backup-fence /app/data/.backup-fence/writers \
    /app/data/.backup-state /app/data/warden-candidates /app/data/warden-evidence \
    /app/data/transformer-candidates /app/data/transformer-evidence \
    /backup/mendpoint /restore
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]

FROM api AS worker
ENV MENDPOINT_REPOS_DIR=/workspace/repos
USER root
RUN mkdir -p /workspace/repos && chown node:node /workspace/repos
USER node
HEALTHCHECK NONE
CMD ["node", "--import", "tsx", "apps/worker/src/cli.ts", "run-jobs", "--interval", "5000"]

FROM api AS fly
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /app/runs /app/.mendpoint \
  && ln -s /data/runs /app/runs \
  && ln -s /data/state/mendpoint /app/.mendpoint
COPY --from=web --chown=node:node /app /web
COPY --chown=root:root scripts/start-fly.mjs /app/scripts/start-fly.mjs
ENV API_HOST=127.0.0.1
ENV MENDPOINT_DATA_DIR=/data/db
ENV MENDPOINT_REPOS_DIR=/data/repos
ENV MENDPOINT_WORKER_HEARTBEAT_PATH=/data/state/worker-heartbeat.json
ENV GRAPH_LEARN_DB=/data/db/graph-learn.sqlite
ENV MENDPOINT_ALERTS_PATH=/data/state/alerts.jsonl
ENV MENDPOINT_API_URL=http://127.0.0.1:3001
ENV POLL_INTERVAL_MS=5000
ENV MENDPOINT_FEED_POLLING_ENABLED=0
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "scripts/start-fly.mjs"]
