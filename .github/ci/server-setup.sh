#!/usr/bin/env bash
set -euo pipefail

(
  dotnet restore tests/Spatia.Server.Tests.csproj --locked-mode
  dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore
) &
build=$!

(
  cd ../web
  npm install --global npm@11.21.1
  npm ci --no-audit --no-fund
) &
web=$!

(
  docker run --rm --entrypoint /bin/cat caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b /usr/bin/caddy > "$RUNNER_TEMP/spatia-caddy"
  chmod +x "$RUNNER_TEMP/spatia-caddy"
  echo "CADDY_BINARY=$RUNNER_TEMP/spatia-caddy" >> "$GITHUB_ENV"
) &
proxy=$!

failed=0
for pid in "$build" "$web" "$proxy"; do
  wait "$pid" || failed=1
done
exit "$failed"
