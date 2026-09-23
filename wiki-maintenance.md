---
title: Wiki Maintenance
description: Access roles, Git content backups, daily database backups and recovery instructions.
published: true
date: 2026-09-23T14:25:20.926Z
tags: 
editor: markdown
dateCreated: 2026-09-23T14:25:20.926Z
---

# Wiki maintenance

## Address and responsibilities

Use **[https://51.79.242.181:9443/](https://51.79.242.181:9443/)**. The former HTTP address on port 8080 redirects to HTTPS. Wiki.js itself listens only on 127.0.0.1:8083 behind the existing Caddy gateway.

The wiki is the shared handbook. Application source/configuration remains in Git, live task status in Jira and design exploration in Figma. Update the relevant page when behavior changes; record its review date and source build.

## Accounts and page permissions

| Group | Intended access |
| --- | --- |
| Administrators | Site settings, account management and all content |
| Team Editors | Read/create/edit pages, view source/history, upload/read files and use comments |
| Reviewers | Read pages, files and comments; no editing or administration |
| Guests | No anonymous reading of pages, files or comments |

The **team32** account is assigned to Team Editors. Its password is not stored in this wiki or Git. The professor still needs a named account once the login email is confirmed; assign it to Reviewers. Adding a user to a group requires both the group's global permissions and matching page rules.

Keep page scripts, site administration, account management and API-key generation outside the editor role. Use [Wiki.js group documentation](https://docs.requarks.io/groups) when changing access. Search-engine indexing is disabled, but sign-in permissions enforce access.

## Edit and organize content

Use the Markdown editor. Give each page a descriptive title, short description, stable path and relevant links. Edit from the page's edit button; use its History view to inspect revisions. Add meeting notes only after an actual meeting and include the human author when using the shared account.

Check internal links after moving pages. Keep screenshots readable, label their build/date and omit credentials. Retain the original imported README and deployment page as references; use the handbook's current guides for onboarding.

## Git content backup

Wiki.js Storage uses the existing private repository, **branch wiki**, with **Push to target** every five minutes. Wiki changes must not be merged into application main as releases.

[Browse the wiki backup branch](https://github.com/Team-Meshworks/gam300/tree/wiki)

The wiki database is the editing source. Do not independently edit the backup branch and expect changes to sync back. The former bi-directional main-branch target was separated during setup to avoid mixing wiki edits and production releases.

In **Administration → Storage**, inspect the last synchronization result. After a storage interruption, use **Add Untracked Changes**, then **Force Sync**, and verify the remote commit. Do not use Import Everything or Purge Local Repository as routine backup operations.

Git storage backs up content. It does not replace a database/configuration backup for accounts, permissions and settings. See [Wiki.js Git storage](https://docs.requarks.io/storage/git).

## Daily full backup on the VM

The root-owned **vthere-wiki-backup.timer** runs daily at **19:00 UTC / 03:00 Singapore**, with up to five minutes of scheduling jitter. It catches missed runs after downtime and retains approximately 14 days of successful snapshots under **/var/backups/vthere-wiki/**.

Each snapshot contains a PostgreSQL custom-format dump, wiki/gateway configuration, service/timer definitions, the wiki SSH keys and persistent content files. The script validates the dump's archive structure, publishes a complete snapshot before expiring older ones, and restricts backup permissions. These backups contain secrets: never upload them to the wiki or Git.

~~~sh
sudo systemctl list-timers vthere-wiki-backup.timer --all
sudo systemctl start vthere-wiki-backup.service
sudo systemctl show vthere-wiki-backup.service -p Result -p ExecMainStatus
sudo journalctl -u vthere-wiki-backup.service -n 30 --no-pager
~~~

**Limit:** scheduled full backups currently stay on the VM. Git provides an off-host content copy, but full recovery from losing the VM also needs an agreed secure off-host destination for database/configuration snapshots.

## Recovery procedure

1. Preserve the damaged instance and choose the recovery point. Avoid restoring over the live database as a first step.
2. Recreate compatible Wiki.js/PostgreSQL services in an isolated environment using the saved configuration and persistent storage.
3. Restore database.dump into a new database with pg_restore using --exit-on-error --no-owner --no-privileges. Restore the saved keys/content and secure configuration files with restricted permissions.
4. Verify login, account roles, pages, links, navigation and attachments in isolation. Keep Git push disabled in the recovery instance until the result is accepted.
5. Coordinate the cutover and update the canonical URL if needed. Retain the old instance until verification completes.

A database restore was exercised on **23 September 2026** in a separate temporary database: pages, users, groups and navigation were present, the configuration archive was readable, and the saved Git key existed. The temporary database was then removed. This verifies the database/archive backup; it is not a measured full-VM disaster-recovery or reboot test.

## Operating boundaries

The wiki Compose file is /home/team32/wikijs/compose.yaml. Gateway configuration is under /home/vthere-runner/vthere/gateway/. Use scoped Compose commands. Never globally prune Docker resources or remove volumes: the application environments share this host.

Before gateway changes, validate with Caddy. This gateway starts Caddy 2.11 with a config file and its admin API disabled, so its documented SIGUSR1 reload is used. Preserve the certificate volume and port 80 for certificate renewal. See [Caddy reload signals](https://caddyserver.com/docs/command-line#signals).

[Deployment and VM](/en/deployment) · [Team agreements](/en/team) · [Handbook](/en/home)

_Last reviewed: 23 September 2026. HTTPS and the HTTP redirect were checked with normal certificate validation; application revision endpoints were unchanged. Backup/restore evidence refers to operations actually performed during wiki setup._
