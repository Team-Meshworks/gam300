#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

fail() { printf 'Setup failed: %s\n' "$*" >&2; exit 1; }
command -v git >/dev/null || fail 'Install Git and Git LFS; see README.md.'
git lfs version >/dev/null || fail 'Install Git LFS; see README.md.'
command -v docker >/dev/null || fail 'Install and start Docker; see README.md.'
docker compose version >/dev/null || fail 'Docker Compose is required; see README.md.'
engine=$(docker info --format '{{.OSType}}') || fail 'Start Docker and allow this user to access it.'
[[ "$engine" == linux ]] || fail 'Switch Docker to Linux containers.'
docker compose up --help | grep -- --wait >/dev/null || fail 'Update Docker Compose to a version supporting --wait.'
export BUILD_MODE="${BUILD_MODE:-development}"
case "$BUILD_MODE" in development|production) ;; *) fail 'BUILD_MODE must be development (M1) or production.' ;; esac
if [[ -z "${REVISION:-}" ]]; then
  REVISION=$(git rev-parse HEAD) || fail 'Run from a Git checkout with a commit.'
fi
export REVISION

printf 'Restoring the locked 3D assets...\n'
git lfs pull --include='assets/delivery/**,web/editor/public/models/**' --exclude='' || fail 'Git LFS download failed. Check repository access and your network.'
printf 'Installing locked packages, checking, building and testing (%s, %s)...\n' "$BUILD_MODE" "$REVISION"
docker compose --project-name "${COMPOSE_PROJECT_NAME:-seb-local}" up --build --wait --wait-timeout 120 || fail 'Build, tests or startup failed. Read the error above.'
printf 'SEB is ready at http://localhost:%s/\n' "${APP_PORT:-8081}"
printf 'Stop it with: docker compose --project-name %s down\n' "${COMPOSE_PROJECT_NAME:-seb-local}"
