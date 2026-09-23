---
title: deployment
description: 
published: true
date: 2026-09-23T13:23:19.712Z
tags: 
editor: markdown
dateCreated: 2026-09-23T12:57:43.349Z
---

# Development and production

| Branch | GitHub environment | VM URL                     | Private application port |
| ------ | ------------------ | -------------------------- | ------------------------ |
| `dev`  | `development`      | https://51.79.242.181:8443 | `127.0.0.1:8082`         |
| `main` | `production`       | https://51.79.242.181      | `127.0.0.1:8081`         |

Integrate feature work into `dev`. Release through a `dev` → `main` pull request;
CI rejects pull requests into `main` from other branches. Both branches build and test
automatically. Deployment is a separate manual action and never rebuilds the image.
The GitHub environments allow only their matching branches.

GitHub currently rejects branch protection for this private repository with an upgrade
requirement. The workflow checks and environment branch restrictions are configured, but
GitHub does not prevent direct pushes or require passing checks before a merge. Keep the
repository private; enable required pull requests and the `Build and test` check when the
team has access to private-repository branch protection.

The existing Wiki.js deployment uses port 8080 and is independent of these Compose projects.
This M1 deployment contains the editor only. PostgreSQL and the application API remain M2
work; Wiki.js's database is not the application database. Browser storage belongs to each
origin, so development and production drafts are separate.

## Local development

Install Git LFS and use the Node/npm versions in `web/.nvmrc` and `web/package.json`.
After cloning, run `git lfs install` and `git lfs pull`, then use `npm ci` from `web/`.
The normal `npm run dev` workflow remains available.

For the same container used by deployment, install Docker Desktop with Linux containers
and the WSL 2 backend on Windows, then run from the repository root:

```sh
docker compose up --build --wait
```

Open http://localhost:8081. Stop this local application with `docker compose down`.
The Dockerfile builds with pinned Node/npm and serves the result through pinned Caddy.
Only delivery assets enter the build; editable source files and local secrets are excluded.

Browser checks use the locked Playwright package. From `web/`, run once:

```sh
npx playwright install chromium
```

With the container running:

```sh
npm run test:deployment -- http://localhost:8081/
```

## What CI does

`.github/workflows/ci.yml` runs on pull requests into `dev`/`main`, pushes to those branches,
and manual runs. It restores LFS and locked dependencies; checks formatting, lint, asset
integrity, deployment isolation/rollback and unit tests; builds the image; and runs the
full authoring checks against Vite's development server and deployment checks against the
image, including its real web-server configuration. Development-only sample controls are
tested in development; the shipped UI and textures are checked in the container.
The Docker build includes TypeScript checking. Chunk-budget checks also run on branches
where that existing smoke script is present.

Pull-request checks have no package-write permission. After successful branch checks,
a separate publishing job pushes the exact tested image to the private GHCR package
`ghcr.io/team-meshworks/gam300`. Each release records its immutable digest, source commit,
branch and CI run ID. The short-lived image-transfer artifact is retained for two days;
test/web artifacts for 14 days and the small release bundle for 90 days. Retain registry
images needed for rollback; deleting their tags can make old releases unavailable.

Superseded CI runs are cancelled. Deployments are serialized per environment, and a VM
file lock also prevents concurrent changes to the same deployment.

## Deploy or roll back

1. Open the successful **CI** run for the intended branch. Copy its run ID from the summary
   or the number at the end of its GitHub URL.
2. Open **Actions → Deploy → Run workflow**.
3. Select `dev` for development or `main` for production. Enter the CI run ID.
4. The workflow verifies the run's workflow identity, branch, event, success and commit
   before sending a job to the VM. A development image cannot be selected for production.
5. Check the deployment result and open the environment's URL.

Rollback uses the same workflow with an older successful CI run **from the same branch**.
The deployment script also restores the last working release when container health or
the external version check fails. A failed pull leaves the old application untouched.
The first unsuccessful deployment removes only its own newly created Compose project.
This is a single-container replacement; a brief interruption during releases is expected.

`/healthz` and `/version.txt` expose only liveness and the deployed commit. The rest of both
sites initially requires a team login because the current asset catalogue is explicitly
development-only and distribution rights remain unconfirmed. Keep this gate until that
review is resolved. This gate is not the future application account system.

The initial login is stored only on the VM in an owner-readable file. Retrieve it in your
own SSH terminal; do not paste it into GitHub or chat:

```sh
ssh team32@51.79.242.181
cat ~/vthere-access.txt
```

## VM setup

The VM uses Ubuntu 24.04 x86-64, Docker Engine and the Compose plugin. Runtime applications
bind only to loopback; a separate `vthere-gateway` Compose project owns HTTP 80, HTTPS 443
and HTTPS 8443. Preserve the existing SSH and Wiki.js firewall rules when allowing those
three TCP ports. Do not expose Docker's socket or a database port over the network.

`deploy/gateway.Caddyfile` requests a Let's Encrypt IP certificate with the `shortlived`
profile. Caddy renews it automatically; its certificate volume must remain persistent.
Port 80 must remain reachable for ACME validation. This works without a purchased domain.
See [Let's Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
and [Caddy TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls).

Create a private gateway directory on the VM and copy `deploy/gateway.compose.yaml`,
`deploy/gateway.Caddyfile` and `deploy/.env.example` there. Rename the example to `.env`,
set the address/login and generate the password hash with the pinned Caddy image's
`caddy hash-password` command. Preserve single quotes around the hash in `.env` so Compose
does not interpolate its dollar signs. Keep the password outside Git and restrict the file
to its owner. Start the gateway from that directory:

```sh
docker compose -f gateway.compose.yaml up -d
```

Use a dedicated `vthere-runner` account for the self-hosted runner, with Docker access and
the custom `vthere-deploy` label. Install it as a system service using GitHub's runner setup
instructions. This runner executes manual deployment jobs only; build and pull-request
checks run on GitHub-hosted Ubuntu. Docker access grants control over the host: repository
writers and deployment workflow changes must be trusted. Revisit runner isolation before
making the repository public or accepting untrusted workflow changes.

Create GitHub environments `development` and `production`, restrict their deployment branches
to `dev` and `main` respectively, and set each environment's `APP_URL` variable to its URL.
The deploy job uses its short-lived `GITHUB_TOKEN` with package-read permission and removes
its temporary Docker credentials after the run. No VM password or permanent registry token
is stored in the repository.

Application state is kept under `/home/vthere-runner/vthere/{development,production}`.
`current/` records the running image/configuration; `previous/` records the prior successful
deployment. From an SSH session, inspect production with:

```sh
sudo -u vthere-runner docker compose -p vthere-production \
  --env-file /home/vthere-runner/vthere/production/current/.env \
  -f /home/vthere-runner/vthere/production/current/compose.yaml ps
```

Replace `ps` with `logs --tail 100` or `restart web` as needed; replace `production` with
`development` for the other environment. A restart uses the currently deployed image.
Use the deployment workflow to change versions. Do not run global Docker prune or
volume-removal commands on this VM: Wiki.js and its database share the Docker daemon.

## Assets and storage

Large GLBs, Blender sources and the existing Blender backup use Git LFS. Small thumbnails,
manifests and source code stay in normal Git. Existing files are converted going forward;
the setup does not rewrite shared history or remove older Git blobs. Keep LFS objects
available for old commits used by builds. Very large recordings, datasets or installers
belong in access-controlled external storage, with provenance and a stable reference in Git.

Keep `.env` files, keys and registry credentials out of Git. The repository is private;
GHCR packages and CI artifacts containing development assets must retain appropriate access.

## Verification evidence

Verified on 23 September 2026:

| Environment | Deployed commit                            | Successful CI                                                                    | Successful deployment                                                            |
| ----------- | ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Development | `f4ca18e725fdffaa4fa3beb1d78a5bba8026febc` | [35863197853](https://github.com/Team-Meshworks/gam300/actions/runs/35863197853) | [35865493351](https://github.com/Team-Meshworks/gam300/actions/runs/35865493351) |
| Production  | `4f5fa8c98e2556419d23b38f334b017280429feb` | [35864105358](https://github.com/Team-Meshworks/gam300/actions/runs/35864105358) | [35865630988](https://github.com/Team-Meshworks/gam300/actions/runs/35865630988) |

Both live sites passed the Chromium deployment check over trusted HTTPS with the team
login: editor loading, server policy, model/textures, placement and undo. Anonymous
requests to the application require authentication; public health/revision endpoints
report the expected commits. Wiki.js still responds on port 8080.

The [cross-branch guard check](https://github.com/Team-Meshworks/gam300/actions/runs/35865302138)
deliberately supplied a development CI run to production. Validation failed and the VM
deployment job was skipped. An earlier [production CI failure](https://github.com/Team-Meshworks/gam300/actions/runs/35863591012)
also blocked publishing; fixing its Vite/model request interception produced the successful
production run above. That CI failure was discovered during setup, not deliberately injected.

The runner service `actions.runner.Team-Meshworks-gam300.vthere-vm-deploy.service` is enabled
at boot. The application containers and gateway have restart policies; certificate data
persists in the gateway volume. Host reboot recovery and a real failed-release rollback
have not been exercised. Rollback logic is covered by the automated deployment script check.

Private-repository branch protection remains unavailable on the current GitHub plan.
Asset distribution rights and the full save/reload browser loop remain open integration
work. This evidence does not mark all of S34/T13-01 complete.
