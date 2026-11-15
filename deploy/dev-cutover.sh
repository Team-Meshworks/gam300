#!/usr/bin/env bash

pause_dev_ingress() {
  local config="${DEPLOY_ROOT:-$HOME/vthere}/gateway/gateway.Caddyfile"
  local original="$candidate/gateway.before" staged="$candidate/gateway.after" backup reload=false
  outer_gateway=$(docker ps -q --filter label=com.docker.compose.project=vthere-gateway --filter label=com.docker.compose.service=gateway)
  [[ "$outer_gateway" =~ ^[0-9a-f]+$ ]] || { echo 'Expected one running outer gateway' >&2; return 1; }
  cp -- "$config" "$original"
  awk '
    /^https:\/\/\{\$SITE_(HOST|IP)\}:8443 \{$/ {
      if (seen[$1]++) exit 1
      print
      sites++
      if (getline <= 0) exit 1
      if ($0 !~ /^[[:space:]]*import \/config\/spatia-dev-creates\*\.caddy[[:space:]]*$/)
        print "\timport /config/spatia-dev-creates*.caddy"
    }
    { print }
    END { if (sites != 2) exit 1 }
  ' "$original" > "$staged" || { echo 'Could not identify both development gateway sites' >&2; return 1; }
  if ! cmp -s "$original" "$staged" || ! docker exec -i "$outer_gateway" cmp -s /config/spatia-dev-creates.caddy - < "$bundle/deploy/dev-creates.caddy"; then
    docker exec -i "$outer_gateway" sh -ec 'cat > /config/dev-creates.pending' < "$bundle/deploy/dev-creates.caddy"
    sed 's|import /config/spatia-dev-creates\*\.caddy|import /config/dev-creates.pending|' "$staged" |
      docker exec -i "$outer_gateway" caddy validate --config - --adapter caddyfile
    docker exec "$outer_gateway" mv /config/dev-creates.pending /config/spatia-dev-creates.caddy
    reload=true
  fi
  if ! cmp -s "$original" "$staged"; then
    backup=$(mktemp "$directory/backups/gateway-before-cutover.XXXXXX")
    cp -- "$original" "$backup"
    cmp -s "$original" "$config" || { echo 'Gateway configuration changed during cutover setup' >&2; return 1; }
    # Preserve the inode mounted read-only by the running outer gateway.
    cat "$staged" > "$config" || { cat "$backup" > "$config"; return 1; }
  fi
  rm -- "$original" "$staged"
  docker exec "$outer_gateway" touch /config/spatia-dev-creates-paused
  local ip authority port_part
  ip=$(docker exec "$outer_gateway" printenv SITE_IP)
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo 'Invalid development gateway IP' >&2; return 1; }
  authority=${url#https://}
  port_part=443
  if [[ "$authority" == *:* ]]; then port_part=${authority##*:}; fi
  dev_ip_url="https://$ip:$port_part"
  dev_ip_connect="$ip:$port_part:127.0.0.1:$port_part"
  local attempt status
  if $reload; then docker kill --signal=USR1 "$outer_gateway" >/dev/null; fi
  for attempt in {1..15}; do
    status=$(public_curl --silent --show-error --max-time 5 -o /dev/null -w '%{http_code} %header{retry-after}' --request POST "$url/api/v1/projects")
    if [[ "$status" == '503 120' ]]; then break; fi
    if [[ "$attempt" == 1 ]] && ! $reload; then docker kill --signal=USR1 "$outer_gateway" >/dev/null; fi
    sleep 1
  done
  check_dev_creates paused
}

check_dev_creates() {
  local state=$1 origin path status method format
  format='%{http_code} %header{www-authenticate}'
  if [[ "$state" == paused ]]; then format='%{http_code} %header{retry-after}'; fi
  local -a options
  for origin in "$url" "$dev_ip_url"; do
    for path in projects classes projects/00000000-0000-4000-8000-000000000001/duplicate projects/legacy-resolution; do
      options=(--silent --show-error --max-time 8 -o /dev/null)
      if [[ "$origin" == "$dev_ip_url" ]]; then options+=(--connect-to "$dev_ip_connect"); fi
      method=POST
      if [[ "$path" == */legacy-resolution ]]; then
        method=PUT
        options+=(-H 'Cookie: spatia_cutover_probe=1')
      fi
      status=$(public_curl "${options[@]}" --write-out "$format" --request "$method" "$origin/api/v1/$path") || return 1
      if [[ "$state" == paused && "$status" == '503 120' ]]; then continue; fi
      if [[ "$state" == open ]]; then
        if [[ "$status" == '401 SpatiaSession realm="Spatia", login_uri="/api/v1/auth/login"' ]]; then continue; fi
        if [[ "$origin" != "$url" && "${status%% *}" == 400 ]]; then continue; fi
      fi
      echo "Expected development creates $state at $origin/api/v1/$path, got ${status%% *}" >&2
      return 1
    done
  done
}

dev_database_guard() {
  run_release "$1" exec -T postgres psql -X -U spatia -d spatia -v "pause=$2" < "$bundle/deploy/dev-create-guard.sql"
}

drain_dev_service() {
  local service=$1 running id state
  running=$(run_release "$candidate" ps -q --status running "$service") || return 1
  run_release "$candidate" stop --timeout -1 "$service" || return 1
  for id in $running; do
    state=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}' "$id") || return 1
    [[ "$state" == 'exited 0 false' ]] || { echo "Development $service failed to drain cleanly: $state" >&2; return 1; }
  done
}

start_dev_release() {
  local access
  run_release "$candidate" up -d --no-build database-access || return 1
  access=$(run_release "$candidate" ps -a -q database-access) || return 1
  [[ -n "$access" && "$(docker wait "$access")" == 0 ]] || return 1
  # Fresh databases acquire the tables during migration. Guard them before starting the API.
  dev_database_guard "$candidate" on || return 1
  run_release "$candidate" up -d --no-build --no-deps --wait --wait-timeout 120 web api gateway
}

reopen_dev_creates() {
  local release=$1
  dev_database_guard "$release" off || return 1
  docker exec "$outer_gateway" rm /config/spatia-dev-creates-paused || return 1
  check_dev_creates open
}

check_dev_account() (
  if [[ -z "${DEPLOY_SMOKE_USERNAME:-}" ]]; then
    echo 'Development signed-in smoke check skipped (no smoke account configured)'
    return 0
  fi
  local private status
  private=$(mktemp -d) || return 1
  trap 'rm -rf -- "$private"' EXIT
  local -a request=(--silent --show-error --max-time 15)
  public_curl "${request[@]}" --fail --cookie-jar "$private/cookies" "$url/api/v1/auth/csrf" |
    python3 -c 'import json,sys; print("X-CSRF-TOKEN: " + json.load(sys.stdin)["requestToken"])' > "$private/csrf" || return 1
  status=$(public_curl "${request[@]}" --cookie "$private/cookies" --cookie-jar "$private/cookies" \
    --header "@$private/csrf" --header 'Content-Type: application/json' \
    --data-binary @<(python3 -c 'import os,json; print(json.dumps({"userName": os.environ["DEPLOY_SMOKE_USERNAME"], "password": os.environ["DEPLOY_SMOKE_PASSWORD"]}))') \
    -o /dev/null -w '%{http_code}' "$url/api/v1/auth/login") || return 1
  [[ "$status" == 204 ]] || { echo "Development smoke login returned $status" >&2; return 1; }
  public_curl "${request[@]}" --fail --cookie "$private/cookies" "$url/api/v1/auth/session" |
    python3 -c 'import json,sys; account=json.load(sys.stdin); sys.exit(0 if account.get("userId") and account.get("mustChangePassword") is False else 1)' || return 1
  status=$(public_curl "${request[@]}" --cookie "$private/cookies" -o /dev/null -w '%{http_code}' "$url/api/v1/projects?limit=1") || return 1
  [[ "$status" == 200 ]]
)
