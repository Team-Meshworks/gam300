---
title: Deployment and VM
description: Development and production releases, rollback, service inspection and shared-VM boundaries.
published: true
date: 2026-09-23T14:08:12.403Z
tags: 
editor: markdown
dateCreated: 2026-09-23T14:08:12.403Z
---

# Deployment and VM

The current M1 application is a static editor served by Caddy. The API and application PostgreSQL integration are M2 work. Wiki.js is a separate service with its own database.

## Environments

| Environment | Branch | URL | Private application port |
| --- | --- | --- | --- |
| Development | dev | [Development demo](https://51.79.242.181:8443/) | 127.0.0.1:8082 |
| Production | main | [Production demo](https://51.79.242.181/) | 127.0.0.1:8081 |

Integrate feature work into dev. Promote releases through a **dev → main pull request**. CI rejects other PR source branches into main. The current private-repository GitHub plan does not provide the desired branch-protection enforcement; do not claim direct pushes are technically prevented.

## Build and release flow

1. CI restores Git LFS and locked dependencies.
2. It checks source formatting/lint, assets, unit behavior and deployment isolation/rollback logic.
3. It tests the authoring workflow, builds the Docker image and checks the packaged application.
4. A successful branch run publishes the exact tested image to the private registry and retains its release descriptor.
5. Deployment is a separate manual workflow. It selects that image by immutable digest and does not rebuild it.

[CI configuration](https://github.com/Team-Meshworks/gam300/blob/dev/.github/workflows/ci.yml) is the executable contract. Keep the repository, registry images and artifacts containing development assets access-controlled.

## Deploy a release

1. Open a successful [CI run](https://github.com/Team-Meshworks/gam300/actions) for the intended branch and copy its run ID.
2. Open **Actions → Deploy → Run workflow**.
3. Select dev for development or main for production, and enter that CI run ID.
4. The workflow verifies the source workflow, branch, commit and successful result before invoking the VM runner.
5. Check the result, the environment URL, /healthz and /version.txt. Record the commit/run IDs in [Testing and evidence](/en/testing).

Both demos currently require the team application login because asset distribution rights are unresolved. This gateway login is not the future application account system and is separate from wiki login. Retrieve credentials through the team administrator's approved channel; never paste them into this wiki.

## Roll back

Run the same Deploy workflow with an older successful CI run **from the same branch**. The script also restores the previous release when a health/version check fails. This is a single-container replacement, so brief interruption is expected.

Keep registry images and release descriptors needed for rollback. An automated rollback-script test is recorded; host reboot recovery and a real failed-release rollback were not exercised in the original deployment evidence.

## Inspect an application on the VM

Use an authorized SSH identity for team32@51.79.242.181. The runner owns application state under /home/vthere-runner/vthere/{development,production}.

~~~sh
sudo -u vthere-runner docker compose -p vthere-production \
  --env-file /home/vthere-runner/vthere/production/current/.env \
  -f /home/vthere-runner/vthere/production/current/compose.yaml ps
~~~

Use the same scoped command with **logs --tail 100** or **restart web** when needed. Substitute development for the other environment. Restarting uses the deployed image; use the Deploy workflow to change versions.

## Shared-VM boundaries

- The VM runs Ubuntu 24.04 with Docker Engine and Compose.
- The gateway owns application HTTPS and its persistent certificate volume.
- Wiki.js, its PostgreSQL database and both application environments share the Docker daemon.
- Never use global Docker prune or volume-removal commands on this VM.
- Keep application/database ports private. Do not expose the Docker socket or PostgreSQL.
- Wiki backups and wiki HTTPS are documented in [Wiki maintenance](/en/wiki-maintenance).

The [tracked deployment runbook](https://github.com/Team-Meshworks/gam300/blob/dev/docs/deployment.md) contains setup details and original evidence. The earlier [imported copy](/en/docs/deployment) is retained as a historical reference and may lag Git.

[Getting started](/en/getting-started) · [Evidence](/en/testing) · [Handbook](/en/home)

_Last reviewed: 23 September 2026, against the tracked runbook and actual VM container inventory. No application release was performed as part of the wiki setup._
