#!/usr/bin/env bash
set -euo pipefail

branch=${1:?Usage: deploy.sh main-or-dev image-digest commit}
image=${2:?An immutable image digest is required}
revision=${3:?A commit is required}
api_image=${4:-}
migration_image=${5:-}
server=false
if [[ -n "$api_image" || -n "$migration_image" ]]; then
  [[ -n "$api_image" && -n "$migration_image" ]] || { echo "Both server image digests are required" >&2; exit 1; }
  server=true
fi
case "$branch" in
  main) environment=production; port=8081; server_port=8444; network=172.30.91 ;;
  dev) environment=development; port=8082; server_port=8445; network=172.30.92 ;;
  *) echo "Only main and dev can deploy" >&2; exit 1 ;;
esac
images=("$image")
if $server; then images+=("$api_image" "$migration_image"); fi
for digest in "${images[@]}"; do
  [[ "$digest" =~ ^ghcr\.io/team-meshworks/gam300@sha256:[a-f0-9]{64}$ ]] || {
    echo "Expected this repository's immutable GHCR image" >&2; exit 1;
  }
done
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid commit" >&2; exit 1; }

bundle=$(cd -- "$(dirname -- "$0")" && pwd)
directory="${DEPLOY_ROOT:-$HOME/vthere}/$environment"
umask 077
mkdir -p -- "$directory"
exec 9>"$directory/deploy.lock"
flock -w 300 9
if ! $server && [[ -f "$directory/current/compose.server.yaml" ]]; then
  echo "Choose a release with API and migration images; an editor-only release cannot replace this server stack" >&2
  exit 1
fi
candidate=$(mktemp -d "$directory/.candidate.XXXXXX")
trap 'rm -rf -- "$candidate"' EXIT
cp -- "$bundle/compose.yaml" "$candidate/compose.yaml"
printf 'APP_IMAGE=%s\nAPP_PORT=%s\nREVISION=%s\n' "$image" "$port" "$revision" > "$candidate/.env"
compose=(docker compose --project-name "vthere-$environment")
url=${APP_URL:-http://127.0.0.1:$port}

# Optional outer-gateway credentials; never persist them in release files or curl argv.
basic_user=${DEPLOY_BASIC_AUTH_USERNAME:-}
basic_password=${DEPLOY_BASIC_AUTH_PASSWORD:-}
if [[ -n "$basic_user" || -n "$basic_password" ]]; then
  [[ -n "$basic_user" && -n "$basic_password" && "$url" == https://* &&
     "$basic_user" != *:* && "$basic_user$basic_password" != *$'\n'* &&
     "$basic_user$basic_password" != *$'\r'* ]] || {
    echo "Basic probe authentication requires HTTPS and a complete, single-line credential pair (username cannot contain a colon)." >&2
    exit 1
  }
fi
public_curl() {
  if [[ -n "$basic_user" ]]; then
    local credentials="$basic_user:$basic_password"
    credentials=${credentials//\\/\\\\}
    credentials=${credentials//\"/\\\"}
    printf 'user = "%s"\nbasic\n' "$credentials" | curl -q --config - "$@"
  else
    curl -q "$@"
  fi || { echo "Public deployment probe failed: ${!#}" >&2; return 1; }
}

# Keep all commands on the exact release files, including rollback
run_release() {
  local release=$1
  shift
  local files=(-f "$release/compose.yaml")
  if [[ -f "$release/compose.server.yaml" ]]; then files+=(-f "$release/compose.server.yaml"); fi
  "${compose[@]}" --env-file "$release/.env" "${files[@]}" "$@"
}

if $server; then
  [[ "$url" =~ ^https://([a-zA-Z0-9.-]+)(:[0-9]+)?/?$ ]] || {
    echo "Server deployment requires an explicit HTTPS APP_URL" >&2; exit 1;
  }
  host=${BASH_REMATCH[1]}
  cp -- "$bundle/compose.server.yaml" "$candidate/"
  # Keep the bind-mounted configuration after the temporary release directory moves
  configuration="$directory/gateway-$revision"
  mkdir -p -- "$configuration"
  cp -- "$bundle/deploy/server.Caddyfile" "$configuration/server.Caddyfile"
  if [[ ! -f "$directory/server.env" ]]; then
    database_password=$(openssl rand -hex 32)
    api_password=$(openssl rand -hex 32)
    printf 'SPATIA_DATABASE_PASSWORD=%s\nSPATIA_API_PASSWORD=%s\n' \
      "$database_password" "$api_password" > "$directory/server.env"
  fi
  chmod 600 -- "$directory/server.env"
  cat "$directory/server.env" >> "$candidate/.env"
  printf 'API_IMAGE=%s\nMIGRATION_IMAGE=%s\nSERVER_PORT=%s\nSERVER_NETWORK_PREFIX=%s\nSERVER_ENVIRONMENT=%s\nSERVER_ALLOWED_HOSTS=%s\nSERVER_CADDYFILE=%s\n' \
    "$api_image" "$migration_image" "$server_port" "$network" "${environment^}" "$host" \
    "$configuration/server.Caddyfile" >> "$candidate/.env"
fi

# Pull failure leaves the running release untouched
if $server; then run_release "$candidate" pull; else run_release "$candidate" pull web; fi

# Back up the retained database before every attempt, including failed-rollout retries
if $server; then
  run_release "$candidate" stop api gateway || {
    echo "Could not confirm API/gateway shutdown; deployment stopped." >&2; exit 1;
  }
  run_release "$candidate" up -d --no-build --wait --wait-timeout 120 postgres
  mkdir -p -- "$directory/backups"
  backup=$(mktemp "$directory/backups/before-$revision.XXXXXX.dump")
  if ! run_release "$candidate" exec -T postgres pg_dump -U spatia -d spatia -Fc > "$backup"; then
    rm -f -- "$backup"
    echo "Database backup failed; API and gateway remain stopped without applying migrations" >&2
    exit 1
  fi
fi

healthy() {
  [[ "$(public_curl --fail --silent --show-error --max-time 30 "$url/version.txt")" == "$revision" ]] || return 1
  if $server; then
    # Pass the optional outer Basic gate without signing into the application.
    public_curl --fail --silent --show-error --max-time 15 --output /dev/null "$url/login" || return 1
    public_curl --fail --silent --show-error --max-time 15 --output /dev/null "$url/api/v1/auth/csrf" || return 1
    # Basic authentication must not grant an application session.
    [[ "$(public_curl --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' "$url/api/v1/auth/session")" == 401 ]] || return 1
    # Check the local application stack; anonymous session requests must remain unauthorized
    curl --fail --silent --show-error --retry 12 --retry-delay 1 --retry-connrefused --max-time 5 --retry-max-time 60 -H "Host: $host" -H 'X-Forwarded-Proto: https' --output /dev/null "http://127.0.0.1:$port/api/v1/auth/csrf" || return 1
    [[ "$(curl --silent --show-error --max-time 10 -H "Host: $host" -H 'X-Forwarded-Proto: https' --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/v1/auth/session")" == 401 ]] || return 1
  fi
}

if run_release "$candidate" up -d --no-build --wait --wait-timeout 120 && healthy; then
  if [[ -f "$directory/current/.env" ]]; then
    rm -rf -- "$directory/previous"
    mv -- "$directory/current" "$directory/previous"
  fi
  mv -- "$candidate" "$directory/current"
  if $server; then rm -f -- "$directory/server-recovery-required"; fi
  printf 'Deployed %s: %s (%s)\n' "$environment" "$revision" "$image"
else
  run_release "$candidate" logs --tail 50 || true
  if $server; then
    if ! run_release "$candidate" stop api gateway; then
      echo "Could not confirm API/gateway shutdown. Inspect the running services before retrying." >&2
      exit 1
    fi
    echo "Server deployment failed; API and gateway remain stopped. Correct the failure and rerun Deploy for the current branch commit." >&2
    if [[ -n "${backup:-}" ]]; then echo "Database backup retained at $backup; schema changes were not reversed" >&2; fi
    exit 1
  fi
  if [[ -f "$directory/current/.env" ]]; then
    echo "Deployment failed; restoring the last working $environment runtime" >&2
    run_release "$directory/current" up -d --no-build --wait --wait-timeout 90 web
    previous_revision=$(sed -n 's/^REVISION=//p' "$directory/current/.env")
    [[ "$(curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$port/version.txt")" == "$previous_revision" ]]
  else
    # Keep database and key volumes for inspection after a failed first rollout
    run_release "$candidate" down
  fi
  if [[ -n "${backup:-}" ]]; then echo "Database backup retained at $backup; schema changes were not reversed" >&2; fi
  exit 1
fi
