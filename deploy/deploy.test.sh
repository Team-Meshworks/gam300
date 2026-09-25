#!/usr/bin/env bash
set -euo pipefail

source_directory=$(cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/bundle" "$temporary/state"
cp "$source_directory/deploy.sh" "$temporary/bundle/"
cp "$source_directory/../compose.yaml" "$temporary/bundle/"
export DEPLOY_ROOT="$temporary/deployments" FAKE_STATE="$temporary/state"
export PATH="$temporary/bin:$PATH"
unset APP_URL

cat > "$temporary/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
  case "$1" in
    --env-file) configuration=$2; shift 2 ;;
    pull|up|down|logs) operation=$1; shift ;;
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
esac
MOCK
cat > "$temporary/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
url=${!#}
port=${url#http://127.0.0.1:}
port=${port%%/*}
cat "$FAKE_STATE/$port"
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
