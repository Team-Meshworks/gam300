#!/usr/bin/env bash
set -euo pipefail

# Run as root on the wiki VM. Restore only into a new disposable database.
snapshot=$(find /var/backups/vthere-wiki -mindepth 1 -maxdepth 1 -type d \
  -name '20??????T??????Z' | sort | tail -n 1)
test -n "$snapshot"
database="wiki_restore_check_$(date -u +%Y%m%d%H%M%S)"
database_user=$(docker exec wikijs-db-1 printenv POSTGRES_USER)
docker exec wikijs-db-1 createdb -U "$database_user" "$database"
trap 'docker exec wikijs-db-1 dropdb -U "$database_user" "$database"' EXIT
docker exec -i wikijs-db-1 pg_restore -U "$database_user" -d "$database" \
  --exit-on-error --no-owner --no-privileges < "$snapshot/database.dump"
docker exec wikijs-db-1 psql -U "$database_user" -d "$database" -v ON_ERROR_STOP=1 -Atc \
  "SELECT 'pages=' || count(*) FROM pages; SELECT 'users=' || count(*) FROM users; SELECT 'groups=' || count(*) FROM groups; SELECT 'navigation=' || count(*) FROM navigation;"
tar -tzf "$snapshot/configuration.tar.gz" >/dev/null
test -s "$snapshot/keys/github"
printf 'Database restore and configuration archive verified: %s\n' "$snapshot"
