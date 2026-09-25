#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run as root on the documented VM. Never write database dumps or keys to Git.
backup_root=/var/backups/vthere-wiki
install -d -m 700 "$backup_root"
exec 9>/run/lock/vthere-wiki-backup.lock
flock -n 9
staging=$(mktemp -d "$backup_root/.pending.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT

docker exec wikijs-db-1 sh -c \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges' \
  > "$staging/database.dump"
docker exec -i wikijs-db-1 pg_restore --list < "$staging/database.dump" > /dev/null

tar -czf "$staging/configuration.tar.gz" -C / \
  home/team32/wikijs/compose.yaml home/team32/wikijs/.env \
  home/vthere-runner/vthere/gateway/gateway.Caddyfile \
  home/vthere-runner/vthere/gateway/gateway.compose.yaml \
  home/vthere-runner/vthere/gateway/.env \
  usr/local/sbin/vthere-wiki-backup \
  etc/systemd/system/vthere-wiki-backup.service \
  etc/systemd/system/vthere-wiki-backup.timer
docker cp wikijs-wiki-1:/wiki/data/keys "$staging/keys"
docker cp wikijs-wiki-1:/wiki/data/content "$staging/content"
chmod -R go-rwx "$staging"

destination="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)"
mv -T -- "$staging" "$destination"
trap - EXIT
# Only expire snapshots produced here, after a new complete snapshot exists.
find "$backup_root" -mindepth 1 -maxdepth 1 -type d \
  -name '20??????T??????Z' -mtime +13 -exec rm -rf -- {} +
printf 'Wiki backup completed: %s\n' "$destination"
# ponytail: full backups stay on this VM; add encrypted off-host storage once a destination is agreed.
