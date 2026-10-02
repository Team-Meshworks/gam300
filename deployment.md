---
title: Deployment and VM
description: Development and production releases, rollback, service inspection and shared-VM boundaries.
published: true
date: 2026-10-02T14:59:35.013Z
tags: 
editor: markdown
dateCreated: 2026-09-23T14:08:12.403Z
---

# Deployment and VM

The M1 application is a static editor served by Caddy. The API and application PostgreSQL integration are M2 work. Wiki.js is a separate service with its own database.

## Environments

| Environment | Branch | URL | Private application port |
| --- | --- | --- | --- |
| Development | dev | [Development demo](https://51.79.242.181:8443/) | 127.0.0.1:8082 |
| Production | main | [Production demo](https://51.79.242.181/) | 127.0.0.1:8081 |

Integrate feature work into dev. Promote releases through a **dev → main pull request**. CI rejects other PR source branches into main. The current private-repository GitHub plan does not provide the desired branch-protection enforcement; maintainers enforce reviewer approval and passing checks.

## Verified development release

On **2 October 2026**, dev commit **8f05c0719eb568d9522b2ab55166e4c46619c873** passed [CI 36964933555](https://github.com/Team-Meshworks/gam300/actions/runs/36964933555). [Deploy 36967665801](https://github.com/Team-Meshworks/gam300/actions/runs/36967665801) successfully deployed its tested image to development. The [evidence index](/en/testing) records suites and retained artifacts.

Check /version.txt before a demonstration. A successful development deployment does not establish production parity; main is a separate release. Historical deployment records remain labelled as history in the evidence index.

## Build and release flow

1. CI restores Git LFS and locked dependencies.
2. It checks formatting/lint, assets, unit behavior and deployment isolation/rollback logic.
3. It runs editor, integration, recovery and history browser checks, builds the Docker image and checks the packaged application.
4. A successful dev/main branch run publishes the exact tested image to the private registry and retains its release descriptor. PR checks and feature-branch manual runs do not publish release images.
5. Deployment is a separate manual workflow. It selects that image by immutable digest and does not rebuild it.

[CI configuration](https://github.com/Team-Meshworks/gam300/blob/dev/.github/workflows/ci.yml) and the [tracked runbook](https://github.com/Team-Meshworks/gam300/blob/dev/docs/deployment.md) are the executable/source contracts. Keep the repository, images and artifacts containing development assets access-controlled.

The dev build includes **Open sample project**; main's production build omits it. Native Vite development and production/container defaults differ. Follow the tracked build-mode instructions when reproducing a hosted build locally.

## Deploy a release

1. Open a successful [CI run](https://github.com/Team-Meshworks/gam300/actions) for the intended branch and copy its run ID.
2. Open **Actions → Deploy → Run workflow**.
3. Select dev for development or main for production, and enter that CI run ID.
4. The workflow verifies the source workflow, branch, commit and successful result before invoking the VM runner.
5. Check the result, the environment URL, /healthz and /version.txt. Record the commit/run IDs in [Testing and evidence](/en/testing).

Both demos use the team application login while asset distribution rights remain unresolved. This gateway login is separate from Wiki.js and the planned application account system. Retrieve credentials through the team's approved channel; keep them out of documentation.

## Roll back

Run the same Deploy workflow with an older successful CI run **from the same branch**. The script also restores the previous release when a health/version check fails. This is a single-container replacement, so brief interruption is expected.

Retain registry images and release descriptors needed for rollback. Automated rollback-script tests are recorded; host reboot recovery and a real failed-release rollback were not exercised in the original evidence or this wiki update.

## Inspect an application on the VM

Use an authorized SSH identity for team32@51.79.242.181. The runner owns application state under /home/vthere-runner/vthere/{development,production}.

~~~sh
sudo -u vthere-runner docker compose -p vthere-production \
  --env-file /home/vthere-runner/vthere/production/current/.env \
  -f /home/vthere-runner/vthere/production/current/compose.yaml ps
~~~

Use the same scoped command with **logs --tail 100** or **restart web** when needed. Substitute development for the other environment. Restarting uses the deployed image; use Deploy to change versions.

## Shared-VM boundaries

- The VM runs Ubuntu 24.04 with Docker Engine and Compose.
- The gateway owns application HTTPS and its persistent certificate volume.
- Wiki.js, its PostgreSQL database and both application environments share Docker.
- Avoid global Docker prune and volume removal; use scoped operations.
- Keep application/database ports private and protect the Docker socket.
- Wiki backups, HTTPS and the push-only wiki branch are documented in [Wiki maintenance](/en/wiki-maintenance).

The [tracked deployment runbook](https://github.com/Team-Meshworks/gam300/blob/dev/docs/deployment.md) contains setup details and original evidence. The [imported copy](/en/docs/deployment) is historical and may lag Git.

[Getting started](/en/getting-started) · [Evidence](/en/testing) · [Handbook](/en/home)

_Last reviewed: 2 October 2026 against published dev 8f05c07 and its CI/deployment records. No application release or infrastructure change was performed as part of this wiki update._
