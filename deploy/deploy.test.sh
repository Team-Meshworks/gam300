#!/usr/bin/env bash
set -euo pipefail

source_directory=$(cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/bundle/deploy" "$temporary/state"
cp "$source_directory/deploy.sh" "$temporary/bundle/"
cp "$source_directory/../compose.yaml" "$temporary/bundle/"
cp "$source_directory/../compose.server.yaml" "$temporary/bundle/"
cp "$source_directory/server.Caddyfile" "$temporary/bundle/deploy/"
export DEPLOY_ROOT="$temporary/deployments" FAKE_STATE="$temporary/state"
export PATH="$temporary/bin:$PATH"
unset APP_URL DEPLOY_BASIC_AUTH_USERNAME DEPLOY_BASIC_AUTH_PASSWORD

cat > "$temporary/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_STATE/calls"
service=${!#}
while (($#)); do
  case "$1" in
    --env-file) configuration=$2; shift 2 ;;
    pull|up|down|logs|stop|exec) operation=$1; shift ;;
    *) shift ;;
  esac
done
source "$configuration"
case "$operation" in
  pull) [[ "${FAKE_FAIL_PULL:-0}" == 0 ]] ;;
  up)
    if [[ "$service" == postgres ]]; then
      [[ "${FAKE_FAIL_DATABASE:-0}" == 0 ]]
      exit
    fi
    printf '%s' "$REVISION" > "$FAKE_STATE/$APP_PORT"
    if [[ -n "${API_IMAGE:-}" ]]; then touch "$FAKE_STATE/$APP_PORT-api"; fi
    [[ "$REVISION" != "${FAKE_FAIL_REVISION:-}" ]]
    ;;
  down) rm -f -- "$FAKE_STATE/$APP_PORT" ;;
  logs) echo 'Simulated failed health check' ;;
  stop)
    [[ "${FAKE_FAIL_STOP:-0}" == 0 ]]
    rm -f -- "$FAKE_STATE/$APP_PORT-api"
    ;;
  exec)
    [[ "${FAKE_FAIL_BACKUP:-0}" == 0 ]]
    echo 'Simulated database backup'
    ;;
esac
MOCK
cat > "$temporary/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
url=${!#}
config=''
if [[ " $* " == *' --config - '* ]]; then config=$(cat); fi
if [[ "$url" == https://* && "${FAKE_BASIC_GATE:-0}" == 1 ]]; then
  [[ "$config" == $'user = "probe:correct-password"\nbasic' ]] || exit 22
elif [[ "$url" == http://* && -n "$config" ]]; then
  echo 'Credentials leaked to private HTTP probe' >&2; exit 1
fi
port=${url#*://}
port=${port#*:}
port=${port%%/*}
case "$url" in
  */login) true ;;
  */api/v1/auth/csrf) [[ "${FAKE_FAIL_API:-0}" == 0 ]] ;;
  */api/v1/auth/session) printf '%s' "${FAKE_SESSION_STATUS:-401}" ;;
  *) cat "$FAKE_STATE/$port" ;;
esac
MOCK
chmod +x "$temporary/bin/docker" "$temporary/bin/curl"

image="ghcr.io/team-meshworks/gam300@sha256:$(printf 'a%.0s' {1..64})"
first=$(printf '1%.0s' {1..40})
second=$(printf '2%.0s' {1..40})
third=$(printf '3%.0s' {1..40})
deploy=(bash "$temporary/bundle/deploy.sh")

if "${deploy[@]}" feature "$image" "$first"; then exit 1; fi
if "${deploy[@]}" dev 'ghcr.io/team-meshworks/gam300:latest' "$first"; then exit 1; fi
if "${deploy[@]}" main "$image" 'not-a-commit'; then exit 1; fi
[[ ! -e "$DEPLOY_ROOT" ]]

"${deploy[@]}" dev "$image" "$first"
[[ "$(cat "$FAKE_STATE/8082")" == "$first" ]]
[[ ! -e "$DEPLOY_ROOT/production" ]]
"${deploy[@]}" main "$image" "$second"
[[ "$(cat "$FAKE_STATE/8081")" == "$second" ]]

if FAKE_FAIL_PULL=1 "${deploy[@]}" dev "$image" "$third"; then exit 1; fi
[[ "$(cat "$FAKE_STATE/8082")" == "$first" ]]
if FAKE_FAIL_REVISION="$third" "${deploy[@]}" dev "$image" "$third"; then exit 1; fi
[[ "$(cat "$FAKE_STATE/8082")" == "$first" ]]
grep -qx "REVISION=$first" "$DEPLOY_ROOT/development/current/.env"
[[ "$(cat "$FAKE_STATE/8081")" == "$second" ]]

"${deploy[@]}" dev "$image" "$third"
grep -qx "REVISION=$first" "$DEPLOY_ROOT/development/previous/.env"
grep -qx "REVISION=$third" "$DEPLOY_ROOT/development/current/.env"
[[ "$(cat "$FAKE_STATE/8081")" == "$second" ]]
echo 'PASS: branch isolation, immutable images, pull failure, rollback and previous release retention'

api="ghcr.io/team-meshworks/gam300@sha256:$(printf 'b%.0s' {1..64})"
migration="ghcr.io/team-meshworks/gam300@sha256:$(printf 'c%.0s' {1..64})"
if "${deploy[@]}" dev "$image" "$first" "$api"; then exit 1; fi
if "${deploy[@]}" dev "$image" "$first" "$api" 'untrusted:latest'; then exit 1; fi
if "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi

export APP_URL=https://127.0.0.1:8082
# Invalid credential configuration must fail before any Docker operation.
call_count=$(wc -l < "$FAKE_STATE/calls")
if DEPLOY_BASIC_AUTH_USERNAME=probe "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
if DEPLOY_BASIC_AUTH_PASSWORD=secret "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
if DEPLOY_BASIC_AUTH_USERNAME='bad:user' DEPLOY_BASIC_AUTH_PASSWORD=secret "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
if DEPLOY_BASIC_AUTH_USERNAME=probe DEPLOY_BASIC_AUTH_PASSWORD=$'bad\npassword' "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
[[ "$(wc -l < "$FAKE_STATE/calls")" == "$call_count" ]]
# Failed server rollout preserves the release record but never starts older binaries
if FAKE_FAIL_API=1 "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
grep -qx "REVISION=$third" "$DEPLOY_ROOT/development/current/.env"
[[ ! -e "$FAKE_STATE/8082-api" ]]

# A corrected release can replace a failed attempt without recovery inputs
printf '%s\n' "$first" "$image" "$api" "$migration" > "$DEPLOY_ROOT/development/server-recovery-required"
call_count=$(wc -l < "$FAKE_STATE/calls")
FAKE_BASIC_GATE=1 DEPLOY_BASIC_AUTH_USERNAME=probe DEPLOY_BASIC_AUTH_PASSWORD=correct-password "${deploy[@]}" dev "$image" "$third" "$api" "$migration"
grep -qx "REVISION=$third" "$DEPLOY_ROOT/development/current/.env"
[[ ! -e "$DEPLOY_ROOT/development/server-recovery-required" ]]
tail -n "+$((call_count + 1))" "$FAKE_STATE/calls" | grep -q 'exec -T postgres pg_dump'
[[ -e "$FAKE_STATE/8082-api" ]]

# A Basic gate rejects absent or incorrect credentials; neither is a healthy release.
if FAKE_BASIC_GATE=1 "${deploy[@]}" dev "$image" "$first" "$api" "$migration" > "$temporary/auth-failure.log" 2>&1; then exit 1; fi
grep -q 'Public deployment probe failed: https://127.0.0.1:8082/version.txt' "$temporary/auth-failure.log"
[[ ! -e "$FAKE_STATE/8082-api" ]]
if FAKE_BASIC_GATE=1 DEPLOY_BASIC_AUTH_USERNAME=probe DEPLOY_BASIC_AUTH_PASSWORD=wrong "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
if FAKE_BASIC_GATE=1 DEPLOY_BASIC_AUTH_USERNAME=probe DEPLOY_BASIC_AUTH_PASSWORD=correct-password FAKE_SESSION_STATUS=200 "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
FAKE_BASIC_GATE=1 DEPLOY_BASIC_AUTH_USERNAME=probe DEPLOY_BASIC_AUTH_PASSWORD=correct-password "${deploy[@]}" dev "$image" "$first" "$api" "$migration"
! grep -R -q 'correct-password' "$DEPLOY_ROOT"

"${deploy[@]}" dev "$image" "$first" "$api" "$migration"
[[ ! -e "$DEPLOY_ROOT/development/server-recovery-required" ]]
configuration="$DEPLOY_ROOT/development/current"
grep -qx "API_IMAGE=$api" "$configuration/.env"
grep -qx "MIGRATION_IMAGE=$migration" "$configuration/.env"
grep -qx 'SERVER_ENVIRONMENT=Development' "$configuration/.env"
grep -qx 'SERVER_NETWORK_PREFIX=172.30.92' "$configuration/.env"
[[ -f "$configuration/compose.server.yaml" ]]
[[ -f "$DEPLOY_ROOT/development/gateway-$first/server.Caddyfile" ]]
[[ "$(stat -c %a "$configuration/.env")" == 600 ]]
cp "$DEPLOY_ROOT/development/server.env" "$temporary/saved-server.env"

# Failed backups keep the API closed and never restart an older release
call_count=$(wc -l < "$FAKE_STATE/calls")
if FAKE_FAIL_BACKUP=1 "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
[[ "$(cat "$FAKE_STATE/8082")" == "$first" ]]
[[ ! -e "$FAKE_STATE/8082-api" ]]
! tail -n "+$((call_count + 1))" "$FAKE_STATE/calls" | grep -q 'up .* api$'
call_count=$(wc -l < "$FAKE_STATE/calls")
if FAKE_SESSION_STATUS=200 "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
grep -qx "REVISION=$first" "$configuration/.env"
[[ ! -e "$FAKE_STATE/8082-api" ]]
tail -n "+$((call_count + 1))" "$FAKE_STATE/calls" | grep -q 'exec -T postgres pg_dump'
call_count=$(wc -l < "$FAKE_STATE/calls")
if FAKE_FAIL_PULL=1 "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
! tail -n "+$((call_count + 1))" "$FAKE_STATE/calls" | grep -Eq ' stop | up | exec '
# Shutdown or database-startup failure must stop before migrations
call_count=$(wc -l < "$FAKE_STATE/calls")
if FAKE_FAIL_REVISION="$second" FAKE_FAIL_STOP=1 "${deploy[@]}" dev "$image" "$second" "$api" "$migration" > "$temporary/stop-failure.log" 2>&1; then exit 1; fi
grep -q 'Could not confirm API/gateway shutdown' "$temporary/stop-failure.log"
! tail -n "+$((call_count + 1))" "$FAKE_STATE/calls" | grep -Eq ' up | exec '
if FAKE_FAIL_DATABASE=1 "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
[[ ! -e "$FAKE_STATE/8082-api" ]]
if FAKE_FAIL_REVISION="$second" "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
[[ ! -e "$FAKE_STATE/8082-api" ]]
grep -qx "REVISION=$first" "$configuration/.env"
! grep -q -- '--no-deps' "$FAKE_STATE/calls"
grep -q 'stop api gateway' "$FAKE_STATE/calls"
grep -q 'Simulated database backup' "$DEPLOY_ROOT"/development/backups/*.dump

"${deploy[@]}" dev "$image" "$second" "$api" "$migration"
[[ ! -e "$DEPLOY_ROOT/development/server-recovery-required" ]]
cmp "$temporary/saved-server.env" "$DEPLOY_ROOT/development/server.env"
[[ "$(cat "$FAKE_STATE/8081")" == "$second" ]]
export APP_URL=https://127.0.0.1:8081
"${deploy[@]}" main "$image" "$third" "$api" "$migration"
grep -qx 'SERVER_ENVIRONMENT=Production' "$DEPLOY_ROOT/production/current/.env"
grep -qx 'SERVER_NETWORK_PREFIX=172.30.91' "$DEPLOY_ROOT/production/current/.env"
if cmp -s "$DEPLOY_ROOT/development/server.env" "$DEPLOY_ROOT/production/server.env"; then exit 1; fi
[[ "$(cat "$FAKE_STATE/8082")" == "$second" ]]
if "${deploy[@]}" main "$image" "$first"; then exit 1; fi
[[ "$(cat "$FAKE_STATE/8081")" == "$third" ]]
echo 'PASS: server validation, authenticated probes, backups and retries without recovery inputs'
