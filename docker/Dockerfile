# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci --no-audit --no-fund
RUN npm run build
RUN npm run build --workspace @calendar-agent/web

# Strip dev dependencies from the runtime image.
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S calendar && adduser -S calendar -G calendar

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps

RUN mkdir -p /data && chown -R calendar:calendar /data /app
USER calendar

ENV CALENDAR_AGENT_HOST=0.0.0.0 \
    CALENDAR_AGENT_PORT=4319 \
    CALENDAR_AGENT_DB_PATH=/data/calendar-agent.json

EXPOSE 4319
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4319/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/bin.js"]
