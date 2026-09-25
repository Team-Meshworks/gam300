FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /app/web
RUN npm install --global npm@11.17.0
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY assets/manifest.json /app/assets/manifest.json
COPY assets/delivery/ /app/assets/delivery/
RUN npm run build

FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
RUN setcap -r /usr/bin/caddy
ARG REVISION=local
ENV APP_REVISION=$REVISION
LABEL org.opencontainers.image.source="https://github.com/Team-Meshworks/gam300" \
      org.opencontainers.image.revision=$REVISION
COPY deploy/app.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/web/dist/editor/ /srv/
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
