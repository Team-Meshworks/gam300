# Wiki operations

The [Spatial Experience Builder Handbook](https://51.79.242.181:9443/en/home) is the team's shared
documentation. Nine handbook pages cover scope/milestones, setup, design, deployment,
user guidance, testing, team decisions and wiki maintenance. The two original imported
pages remain available. **Spatial Experience Builder (SEB)** is the product,
**Meshworks (Team 32)** is the development team, and **VThere** is the client company
that commissioned the project. Keep executable configuration in Git and task status in Jira.

## Access

- `meshworks_team32@pm.me` signs in as **team32**, in **Team Editors**. It can read/create/edit
  pages, upload files, comment and read source/history. It has no administration,
  page deletion or page-moving permissions.
- **Reviewers** can read pages, files and comments. No professor account exists yet;
  an administrator should create it with the professor's supplied email and this group.
- **Guests** has no global content permissions. Anonymous requests go to the login page.
- Passwords belong in the team's password manager, never in pages, Git or screenshots.
  Prefer individual editor accounts once team members register, for useful attribution.

## VM and HTTPS

Administrative SSH is `team32@51.79.242.181`. On the setup Windows host the existing key
is `C:/Users/kille/.ssh/gam300-deploy`; its private contents stay outside this repository.

| Component | Location / port |
| --- | --- |
| Wiki Compose | `/home/team32/wikijs/compose.yaml`, project `wikijs` |
| Wiki container | `wikijs-wiki-1`, `127.0.0.1:8083` → container 3000 |
| Database | `wikijs-db-1`, PostgreSQL 15, no public database port |
| Gateway | `/home/vthere-runner/vthere/gateway`, project `vthere-gateway` |
| Wiki URL | HTTPS 9443; HTTP 8080 redirects to the same path on HTTPS 9443 |
| Wiki data | Existing `wikijs_wiki-data` and `/wiki/data/content` volumes |
| Database data | Existing `wikijs_db-data` volume |

[`gateway.Caddyfile`](../deploy/gateway.Caddyfile) provides TLS through the existing
Caddy gateway and its automatically renewed Let's Encrypt IP certificate. Preserve
port 80 for ACME, port 9443 for the wiki, SSH access and the gateway certificate volume.
The application gates on 443/8443 remain separate from Wiki.js authentication.

Before changing the gateway, validate the candidate with its running Caddy image. The
gateway has `admin off`; Caddy 2.11 supports a graceful reload with:

```sh
sudo docker kill --signal=SIGUSR1 vthere-gateway-gateway-1
```

Write the validated config into the existing bind-mounted file before sending that
signal. Do not replace its inode. The pre-HTTPS configuration is retained privately at
`/home/team32/wikijs/before-https-20260923`. Avoid global Docker prune or volume removal.

## Backups

Wiki.js Git storage pushes content every five minutes to the private repository's
**`wiki` branch**. It does not pull content or write to `main`/`dev`. Do not merge this
backup branch into an application branch. Administration → Storage offers **Force Sync**;
**Add Untracked Changes** exports existing database content when needed. Git content is
not a database, account, settings or full asset backup.

The native `vthere-wiki-backup.timer` runs daily at **03:00 Singapore**, with up to five
minutes of jitter and a catch-up after downtime. It retains approximately 14 days under
`/var/backups/vthere-wiki`, readable only by root. Each successful snapshot contains a
PostgreSQL custom-format dump, private wiki/gateway configuration, wiki SSH keys and
persistent content. Expiration runs only after a new complete snapshot is created.

Install/update from a Linux checkout on the VM after reviewing the scripts:

```sh
sudo install -m 700 deploy/wiki-backup.sh /usr/local/sbin/vthere-wiki-backup
sudo install -m 644 deploy/wiki-backup.service deploy/wiki-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vthere-wiki-backup.timer
sudo systemctl start vthere-wiki-backup.service
sudo systemctl show vthere-wiki-backup.service -p Result -p ExecMainStatus
sudo systemctl list-timers vthere-wiki-backup.timer
sudo bash deploy/wiki-restore-check.sh
```

The restore check creates a separate temporary database, restores the latest snapshot,
queries its key tables, verifies the archive is readable and drops only that temporary
database. Run it after backup changes and periodically. A full recovery additionally
requires restoring configuration/keys/content to their recorded mounts on an isolated
host, restoring the database, then verifying login, permissions, pages and attachments
before switching traffic. Do not overwrite the live database as a test.

**Remaining limit:** full backups are on this VM. Git provides an off-host content copy,
but a secure off-host destination for the complete snapshots still needs to be chosen.
Snapshots contain credentials and private keys; transfer them only to protected storage.

## Verification on 23 September 2026

- Trusted HTTPS and HTTP→HTTPS redirect work; both application version responses remained
  unchanged. Caddy configuration validation passed.
- Anonymous access goes to login. The team32 login reads the handbook and opens its editor;
  `/a` returns Unauthorized. Saved role permissions and the canonical HTTPS URL were checked.
- All nine new pages are published. Internal handbook links resolve to published pages;
  the sidebar and architecture diagram render correctly.
- Git sync was verified at `4ed3b9e` on `wiki`, containing all nine new handbook pages;
  `main` remained at `5ba6f8f`.
- The naming correction was synced at `7cc786e`: SEB is the product, Meshworks the team,
  and VThere the client. Sign-in with `meshworks_team32@pm.me` and the existing password
  succeeded, and a fresh backup completed successfully.
- Backup shell syntax and systemd units passed validation. Snapshot
  `20260923T143600Z` restored into a separate database with 11 pages, 3 user records,
  4 groups and navigation. Its configuration archive was readable; the service exited 0.
- A complete host restore, reboot recovery and off-host full-backup recovery have not been
  exercised. This setup does not mark application or milestone requirements complete.
