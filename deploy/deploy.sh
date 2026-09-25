#!/usr/bin/env bash
set -euo pipefail

branch=${1:?Usage: deploy.sh main-or-dev image-digest commit}
image=${2:?An immutable image digest is required}
revision=${3:?A commit is required}
case "$branch" in
  main) environment=production; port=8081 ;;
  dev) environment=development; port=8082 ;;
  *) echo "Only main and dev can deploy" >&2; exit 1 ;;
esac
[[ "$image" =~ ^ghcr\.io/team-meshworks/gam300@sha256:[a-f0-9]{64}$ ]] || {
  echo "Expected this repository's immutable GHCR image" >&2; exit 1;
}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid commit" >&2; exit 1; }

bundle=$(cd -- "$(dirname -- "$0")" && pwd)
directory="${DEPLOY_ROOT:-$HOME/vthere}/$environment"
mkdir -p -- "$directory"
exec 9>"$directory/deploy.lock"
flock -w 300 9
candidate=$(mktemp -d "$directory/.candidate.XXXXXX")
trap 'rm -rf -- "$candidate"' EXIT
cp -- "$bundle/compose.yaml" "$candidate/compose.yaml"
printf 'APP_IMAGE=%s\nAPP_PORT=%s\nREVISION=%s\n' "$image" "$port" "$revision" > "$candidate/.env"
compose=(docker compose --project-name "vthere-$environment")
url=${APP_URL:-http://127.0.0.1:$port}

# Pull failure leaves the running release and its configuration untouched
"${compose[@]}" --env-file "$candidate/.env" -f "$candidate/compose.yaml" pull web
if "${compose[@]}" --env-file "$candidate/.env" -f "$candidate/compose.yaml" \
  up -d --no-build --wait --wait-timeout 90 web &&
  [[ "$(curl --fail --silent --show-error --max-time 30 "$url/version.txt")" == "$revision" ]]; then
  if [[ -f "$directory/current/.env" ]]; then
    mkdir -p -- "$directory/previous"
    cp -- "$directory/current/.env" "$directory/current/compose.yaml" "$directory/previous/"
  fi
  mkdir -p -- "$directory/current"
  cp -- "$candidate/.env" "$candidate/compose.yaml" "$directory/current/"
  printf 'Deployed %s: %s (%s)\n' "$environment" "$revision" "$image"
else
  "${compose[@]}" --env-file "$candidate/.env" -f "$candidate/compose.yaml" logs --tail 50 web || true
  if [[ -f "$directory/current/.env" ]]; then
    echo "Deployment failed; restoring the last working $environment release" >&2
    "${compose[@]}" --env-file "$directory/current/.env" -f "$directory/current/compose.yaml" \
      up -d --no-build --wait --wait-timeout 90 web
    previous_revision=$(sed -n 's/^REVISION=//p' "$directory/current/.env")
    [[ "$(curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$port/version.txt")" == "$previous_revision" ]]
  else
    "${compose[@]}" --env-file "$candidate/.env" -f "$candidate/compose.yaml" down
  fi
  exit 1
fi
