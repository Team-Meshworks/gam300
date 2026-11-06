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
unset APP_URL DEPLOY_BASIC_AUTH_USERNAME DEPLOY_BASIC_AUTH_PASSWORD RECOVERY_FROM_REVISION RECOVERY_REVIEW

cat > "$temporary/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_STATE/calls"
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
    printf '%s' "$REVISION" > "$FAKE_STATE/$APP_PORT"
    [[ "$REVISION" != "${FAKE_FAIL_REVISION:-}" ]]
    ;;
  down) rm -f -- "$FAKE_STATE/$APP_PORT" ;;
  logs) echo 'Simulated failed health check' ;;
  stop) [[ "${FAKE_FAIL_STOP:-0}" == 0 ]] ;;
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
[[ -f "$DEPLOY_ROOT/development/server-recovery-required" ]]

# A Basic gate rejects absent or incorrect credentials; neither is a healthy release.
if FAKE_BASIC_GATE=1 "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
[[ -f "$DEPLOY_ROOT/development/server-recovery-required" ]]
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

# Failed backups leave the running release alone
if FAKE_FAIL_BACKUP=1 "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
[[ "$(cat "$FAKE_STATE/8082")" == "$first" ]]
call_count=$(wc -l < "$FAKE_STATE/calls")
if FAKE_SESSION_STATUS=200 "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
if tail -n "+$((call_count + 1))" "$FAKE_STATE/calls" | grep -q -- '--no-deps --wait --wait-timeout 90 web api gateway'; then
  echo 'FAIL: a failed server rollout restarted the old API against retained database state' >&2
  exit 1
fi
[[ -f "$DEPLOY_ROOT/development/server-recovery-required" ]]
call_count=$(wc -l < "$FAKE_STATE/calls")
if "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
[[ "$(wc -l < "$FAKE_STATE/calls")" == "$call_count" ]]
# Recovery identity includes every image, not just its advertised commit
different_api="ghcr.io/team-meshworks/gam300@sha256:$(printf 'd%.0s' {1..64})"
if "${deploy[@]}" dev "$image" "$second" "$different_api" "$migration"; then exit 1; fi
if "${deploy[@]}" dev "$image" "$second"; then exit 1; fi
[[ "$(wc -l < "$FAKE_STATE/calls")" == "$call_count" ]]
cp "$DEPLOY_ROOT/development/server-recovery-required" "$temporary/guard"
printf 'damaged guard\n' > "$DEPLOY_ROOT/development/server-recovery-required"
if "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
[[ "$(wc -l < "$FAKE_STATE/calls")" == "$call_count" ]]
cp "$temporary/guard" "$DEPLOY_ROOT/development/server-recovery-required"
if FAKE_FAIL_PULL=1 "${deploy[@]}" dev "$image" "$second" "$api" "$migration"; then exit 1; fi
cmp "$temporary/guard" "$DEPLOY_ROOT/development/server-recovery-required"
# A Docker shutdown failure must report uncertainty and keep the recovery restriction
if FAKE_FAIL_REVISION="$second" FAKE_FAIL_STOP=1 "${deploy[@]}" dev "$image" "$second" "$api" "$migration" > "$temporary/stop-failure.log" 2>&1; then exit 1; fi
grep -q 'Could not confirm API/gateway shutdown' "$temporary/stop-failure.log"
cmp "$temporary/guard" "$DEPLOY_ROOT/development/server-recovery-required"
! grep -q -- '--no-deps --wait --wait-timeout 90 web api gateway' "$FAKE_STATE/calls"
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
echo 'PASS: server validation, private settings, API health, backups and fail-closed guarded recovery'

# Explicit reviewed recovery replaces a blocked release without starting old binaries.
export APP_URL=https://127.0.0.1:8082
if FAKE_FAIL_API=1 "${deploy[@]}" dev "$image" "$third" "$api" "$migration"; then exit 1; fi
cp "$DEPLOY_ROOT/development/server-recovery-required" "$temporary/review-guard"
call_count=$(wc -l < "$FAKE_STATE/calls")
if RECOVERY_FROM_REVISION="$first" RECOVERY_REVIEW=approved "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
if RECOVERY_FROM_REVISION="$third" "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
[[ "$(wc -l < "$FAKE_STATE/calls")" == "$call_count" ]]
for failure in FAKE_FAIL_PULL FAKE_FAIL_STOP; do
  if env "$failure=1" RECOVERY_FROM_REVISION="$third" RECOVERY_REVIEW=approved "${deploy[@]}" dev "$image" "$first" "$api" "$migration"; then exit 1; fi
  cmp "$temporary/review-guard" "$DEPLOY_ROOT/development/server-recovery-required"
done
RECOVERY_FROM_REVISION="$third" RECOVERY_REVIEW='Reviewed deployment-only change' "${deploy[@]}" dev "$image" "$first" "$api" "$migration"
[[ ! -e "$DEPLOY_ROOT/development/server-recovery-required" ]]
records=("$DEPLOY_ROOT/development/recovery-records"/review.*)
[[ ${#records[@]} == 1 ]]
cmp "$temporary/review-guard" "${records[0]}/previous-guard"
grep -qx 'Reviewed deployment-only change' "${records[0]}/review"
[[ "$(head -n 1 "${records[0]}/replacement")" == "$first" ]]
echo 'PASS: reviewed recovery validates identity, retains guards on failure and archives approval'
