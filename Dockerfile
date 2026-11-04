FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app/apps/web
ARG BUILD_MODE=production
RUN case "$BUILD_MODE" in development|production) ;; *) echo >&2 "Invalid BUILD_MODE: use development for M1 or production for release builds"; exit 1 ;; esac
RUN npm install --global npm@11.21.1
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
# Standalone builds run static and unit checks; browser proof runs on a non-root host
ARG RUN_BUILD_CHECKS=true
RUN case "$RUN_BUILD_CHECKS" in true|false) ;; *) echo >&2 "Invalid RUN_BUILD_CHECKS: use true or false"; exit 1 ;; esac
# Chrome cannot be safely assumed to have a working sandbox in Docker build.
# Run tools/check-browser.mjs on a non-root sandbox-capable host; CI also tests the final image.
COPY apps/web/ ./
COPY assets/manifest.json /app/assets/manifest.json
COPY assets/delivery/ /app/assets/delivery/
COPY tools/validate-assets.mjs tools/asset-content-validation.mjs /app/tools/
RUN node /app/tools/validate-assets.mjs --delivery-only
RUN if [ "$RUN_BUILD_CHECKS" = true ]; then npm run lint && npm run format:check && npm run test:browser-policy && npm run test:unit; fi
RUN NODE_ENV="$BUILD_MODE" npm run build:editor -- --mode "$BUILD_MODE"

FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
RUN setcap -r /usr/bin/caddy
ARG REVISION=local
ENV APP_REVISION=$REVISION
LABEL org.opencontainers.image.source="https://github.com/Team-Meshworks/gam300" \
      org.opencontainers.image.revision=$REVISION
COPY deploy/app.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist/editor/ /srv/
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz && wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
