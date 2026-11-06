# Development and production

| Branch | GitHub environment | VM URL                     | Private application port |
| ------ | ------------------ | -------------------------- | ------------------------ |
| `dev`  | `development`      | https://51.79.242.181:8443 | `127.0.0.1:8082`         |
| `main` | `production`       | https://51.79.242.181      | `127.0.0.1:8081`         |

Integrate feature work into `dev`. Release through a `dev` to `main` pull request.
CI runs automatically only after pushes to `dev` or `main`, including merge commits.
Pull requests do not start CI. Manual CI dispatch runs test jobs on the selected
branch, including feature and hardening branches. Publishing remains restricted to
`dev` and `main`. Deployment is a separate manual action and never rebuilds the image.

The promotion rule still requires a PR into `main` to come from this repository's
`dev` branch. Removing PR-triggered CI also removes its automatic source-branch
check, so reviewers must verify the source repository and branch before merging.
This is a manual safeguard, not an equivalent automated enforcement mechanism.
The GitHub environments allow only their matching branches.

CI builds `dev` with `NODE_ENV=development` and Vite's `development` mode, including
**Open sample project** and framework development diagnostics. `main` uses
`NODE_ENV=production` and `production` mode. Manual runs use the selected supported
branch's mode. Both images contain built static files served by Caddy, with the same
health checks. Account access is handled by Spatia's login and API session checks.
Recovery depends on whether the release includes the
server stack; see [Deploy and recover](#deploy-and-recover).
Existing images keep their original build mode. After these workflow changes reach
`dev` or `main`, deploy a new successful CI run to apply the branch's build mode.

GitHub currently rejects branch protection for this private repository with an upgrade
requirement. Automatic workflow checks and environment branch restrictions are configured, but
GitHub does not prevent direct pushes or require passing checks before a merge. Keep the
repository private. Feature PR reviewers must verify approval and local check results
before merging into `dev`. Before promoting to `main`, verify the `dev` source branch
and a successful CI run for the exact `dev` commit being promoted. CI checks the
integrated `main` commit after merging; deploy only after that run succeeds.
Revisit enforced required checks when private-repository branch protection becomes available.

Wiki.js is available at https://51.79.242.181:9443 with sign-in required. Its separate
Compose project binds to `127.0.0.1:8083`; the gateway redirects legacy HTTP port 8080
to HTTPS. See [wiki operations](wiki.md) for accounts and backups.
Earlier M1 releases contain the editor only. Server-inclusive releases add the API and
PostgreSQL; Wiki.js's database is not the application database. Browser storage belongs to each
origin, so development and production drafts are separate.

## Local development

Install Git LFS and use the Node/npm versions in `apps/web/.nvmrc` and `apps/web/package.json`.
After cloning, run `git lfs install` and `git lfs pull`, then use `npm ci` from `apps/web/`.
The normal `npm run dev` workflow remains available.

For the same container used by deployment, install Docker with Linux containers and
Compose, then run from the repository root:

```sh
bash run.sh
```

On Windows, use `run.bat`. Open http://localhost:8081. Stop this local application with
`docker compose --project-name spatia-local down`.
The Dockerfile builds with pinned Node/npm and serves the result through pinned Caddy.
The launchers restore Git LFS delivery assets and check prerequisites. The container
build runs lint, formatting, browser-policy and unit tests, TypeScript and build
checks before the web service starts. Real browser proof runs separately on a
non-root sandbox-capable host. CI sets `RUN_BUILD_CHECKS=false` after its source
checks pass, then tests the final Caddy image from that host. Host Node/npm and
Chrome are unnecessary just to start the container. This launcher starts the editor
only; use the API Compose configuration
below to include PostgreSQL and the API.
Only delivery assets enter the build; editable source files and local secrets are excluded.
The existing asset validator runs with `--delivery-only` inside the build: it checks
GLB contents and manifest hashes without needing Blender sources. A remaining LFS
pointer fails with an instruction to run `git lfs pull`. Licence warnings stay visible.
The runtime keeps its read-only filesystem and user `1000:1000`; its temporary storage
mounts belong to that user. Health checks require both `/healthz` and the editor page.

Local Compose and the launchers default to the M1 development build. The Dockerfile's
default remains production; CI selects the branch's mode explicitly. The launchers
set `/version.txt` to the checkout commit unless `REVISION` is supplied. For an explicit
development build from PowerShell:

```powershell
$env:BUILD_MODE = "development"
./run.bat
```

Set `BUILD_MODE` to `production` to build the production variant. Without Docker, from
`apps/web/`, use `$env:NODE_ENV = "development"` followed by
`npm run build:editor -- --mode development` and `npm run preview`. Set `NODE_ENV`
and `--mode` to `production` for the production variant; changing only Vite's mode
does not enable development controls.

To check the built controls locally, set `BUILD_MODE` to the matching mode and run
`node tests/editor-build.check.mjs http://localhost:4173/` from `apps/web/` while preview is running.

Browser checks use the locked Playwright package. From `apps/web/`, run once:

```sh
npm run browser:install
npm run browser:verify
```

With the container running:

```sh
npm run test:deployment -- http://localhost:8081/
```

Run browser checks from a non-root sandbox-capable host with the pinned Node/npm
and verified official Chrome. The Docker build image deliberately does not install
or launch a browser; running it as root is not an alternative to sandbox proof.
From `apps/web/`, with the development container running on its normal host port:

```sh
node tests/deployment.check.mjs http://127.0.0.1:8081/
BUILD_MODE=development node tests/editor-build.check.mjs http://127.0.0.1:8081/
```

In PowerShell, set `$env:BUILD_MODE = "development"` before the second command.
For production, select `production` in both the image build and test environment.
The deployment check exercises place/move/undo, JSON Save/Open, reload and recovered
undo through the packaged UI. From the repository root, `node tools/check-browser.mjs`
checks the four source-level authoring suites against Vite and the built preview.
CI runs both source fixtures and packaged-application checks on its non-root host.
Do not add `--no-sandbox`, privileged containers, or weakened host security settings.

## Local API and PostgreSQL integration

For optional full-stack testing, `compose.server.yaml` adds the API and PostgreSQL
to the editor. It requires a running Docker Linux engine. Standard editor development
uses the setup above; shared environment addresses are listed at the top of this guide.

Set `SPATIA_DATABASE_PASSWORD` and `SPATIA_API_PASSWORD` privately in your environment
or an ignored root `.env` file. Use different randomly generated hexadecimal passwords
of at least 32 characters. Keep them stable when restarting an existing database;
changing `POSTGRES_PASSWORD` does not rotate an already initialised PostgreSQL account.
Do not print resolved Compose configuration or commit credentials.

`API_IMAGE` and `MIGRATION_IMAGE` select prebuilt API and migration images; local builds
default to `spatia-api:local` and `spatia-migrations:local`.

To enable publication, set `PUBLICATION_ORIGIN` to the externally reachable HTTPS
origin, for example `https://localhost:8444` for this local stack. Use only an origin:
no credentials, path, query or fragment. Compose passes it to the API as
`Publication__Origin`; if it is unset or invalid, publishing remains unavailable.
For another device, configure the actual HTTPS origin reachable and trusted by that
device. Request headers do not choose the returned publication URL.

From the repository root:

```sh
docker compose -f compose.yaml -f compose.server.yaml -p spatia-server config --quiet
docker compose -f compose.yaml -f compose.server.yaml -p spatia-server up -d --build --wait
```

The editor and API share `https://localhost:8444`; `SERVER_PORT` changes the host port.
Caddy issues a local certificate. Its CA certificate is stored in the gateway data
volume at `/data/caddy/pki/authorities/local/root.crt`; use that certificate with your
test client's CA option without installing it in the operating system trust store.
Browsers show a certificate warning for this local CA by default.
Keep TLS verification enabled in integration checks. Check the editor, `/healthz` and
`/api/auth/session`; an anonymous session request must return 401.

Startup applies migrations before granting the API restricted database access. The
database has no host port; the running API receives its own password and persists
cookie-encryption keys separately. Stop the stack while retaining its database and keys:

```sh
docker compose -f compose.yaml -f compose.server.yaml -p spatia-server down
```

Do not add `--volumes` when keeping project or account data.

## What CI does

`.github/workflows/ci.yml` runs automatically on pushes to `main` or `dev`.
Manual `workflow_dispatch` also runs validation on other branches; PRs do not
trigger runs. Only `main` and `dev` runs publish an image. CI restores LFS and
locked dependencies; checks formatting, lint, asset
integrity, deployment isolation/rollback and unit tests; builds the image; and runs the
authoring and recovery/file checks against Vite's development server and deployment checks against the
image, including its real web-server configuration. The packaged-build browser check verifies
that the sample control loads its project in development and is absent in production.
The Docker build includes TypeScript checking. Both build modes retain the 500 kB
JavaScript chunk-budget check.

Lint and formatting run once on Linux. Native Windows and macOS jobs retain setup,
dependency-boundary, unit and build checks. Module-removal experiments run when
architecture tooling, package manifests, compiler/build configuration or CI changes,
and on manual runs. Every run still checks live imports for forbidden dependencies
and cycles. CI generates the detailed architecture graph as a test artifact; comment
and line-number changes do not require regenerating a tracked graph to pass.

Browser, integration, caching, recovery, history and workspace checks run in separate
fixture jobs against Vite. The workspace routes are also checked against the packaged
Caddy application. Publishing waits for every fixture job and all required build/test
jobs; the architecture proof may be skipped only when its selector reports it unnecessary.

The recovery check includes place–move–undo–save–reload and JSON transfer into a fresh
browser context. Its output and the editor check output are retained under `apps/web/test-results/`.

The server job uses the SDK pinned in `apps/server/global.json`, locked NuGet restore,
Release build, both C# format checks, migration checks and the complete TUnit suite.
Its disposable PostgreSQL 18.6 service publishes only to loopback and uses synthetic
test credentials. The suite applies migrations in isolated schemas and includes the
existing Chromium account flow. Test reports and browser-version evidence are retained
for 14 days. The separate account cold-restart acceptance remains a local operator check;
see the [server setup](../apps/server/README.md).

The check job has no package-write permission. After a successful push or manual run on
`dev` or `main`, and after the web, native compatibility and server jobs pass, a separate
publishing job pushes the exact tested image to the private GHCR package
`ghcr.io/team-meshworks/gam300`. Each release records its immutable digest, source commit,
branch and CI run ID. The short-lived image-transfer artifact is retained for two days;
test/web artifacts for 14 days and the small release bundle for 90 days. Retain registry
images and release bundles needed for reviewed recovery; old images may become unavailable.
Feature branches do not run these checks in Actions; run the relevant checks locally
before requesting review.

Superseded CI runs are cancelled. Deployments are serialized per environment, and a VM
file lock also prevents concurrent changes to the same deployment.

The web check also starts the editor/API/PostgreSQL stack and verifies HTTPS,
CSRF bootstrap, anonymous access denial, migrations and the restricted database role.
Failure logs are retained; disposable CI volumes are removed after the check.
Releases include the tested editor, API and migration images, both Compose
configurations and the gateway configuration. `release.json` records the image
digests as `image`, `apiImage` and `migrationImage`.

### Run CI on demand

Open **Actions > CI > Run workflow**, select `dev` or `main`, then choose **Run workflow**.
With an authenticated GitHub CLI, the equivalent is:

```sh
gh workflow run ci.yml --ref dev
```

Choose `dev` for a development release or `main` for a production release.
Feature-branch checks must be run locally. Merging into either supported branch
automatically runs CI on the resulting commit. Deployment requires the selected
run to match the current branch head and deploys that run's tested images.

Manual dispatch requires repository write access, and the workflow must exist on the
default branch. Workflow changes follow the same feature to dev to main promotion path.
See GitHub's
[manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Deploy and recover

1. Wait for the intended branch's push CI run or manually run **CI**. Copy its run ID from the summary
   or the number at the end of its GitHub URL.
2. Open **Actions > Deploy > Run workflow**.
3. Select `dev` for development or `main` for production. Enter the CI run ID.
4. The workflow verifies the run's workflow identity, branch, event, success and commit,
   then checks the branch head again after environment approval and before Docker login.
   Older runs and development images for production are rejected.
5. Check the deployment result and open the environment's URL.

Server deployments require a release containing all three images. The supported workflow
does not deploy older runs, including as a rollback. A failed image pull leaves the existing
release running. Releases may briefly interrupt service.

Development and production use separate databases and credentials. Before updating,
the deployment backs up the database to `backups/`; a failed backup stops the update.
Database volumes are preserved after failures.

Before candidate startup, the deploy script records the revision and all three image
digests in `server-recovery-required` under the environment directory. A failed or
interrupted attempt leaves that guard in place; after a reported startup or health
failure, the API and application gateway are stopped. The same release can be retried;
the guarded retry skips a new backup and does not restart the old API. A successful
retry promotes the release and clears the guard. If backup fails before candidate startup,
the unchanged API is restarted. Editor-only releases retain their prior runtime rollback.
An interrupted process may leave candidate services running; inspect their state and stop
the API and application gateway before a reviewed recovery if they are still running.

For a server recovery, keep the guard and use the current deploy procedure to retry the
exact recorded revision and image digests while that revision remains the branch head;
do not clear the guard manually for an exact retry. If a different release is needed,
an operator must first review its schema and authorization compatibility with the actual
retained database, including data written after the backup, and prepare a safe recovery
plan. Keep the API and gateway unavailable through that review. Once the plan is approved,
archive the guard as part of the recovery record, then deploy a successful CI release for
the new current branch commit. Do not invoke an older deploy script, rewind the branch to
bypass these controls, or blindly restore a backup: migrations are not reversed and
restoring a backup can discard later writes. Database restoration requires a reviewed
procedure during downtime. Keep backups outside the VM as well.

The existing HTTPS gateway remains in place. Spatia accounts provide sign-in, and API
and database services are not exposed directly.

The application Caddy HTTP listener accepts forwarded headers only from the explicit
application bridge gateway address (`SERVER_NETWORK_PREFIX`.1/32); it resolves the
client IP using strict proxy parsing and forwards one normalized address to the API.
The API trusts the inner Caddy's fixed address and consumes one forwarded hop. The local
HTTPS listener does not trust forwarded client headers. Preserve the outer gateway's
header sanitization and the loopback-only port binding; verify the observed bridge peer
and forwarding behavior in the target Linux Docker environment before deployment.

`/healthz` and `/version.txt` expose only liveness and the deployed commit. The login page
and static frontend files are public; protected project and administration data require
an authenticated API session. The old shared team HTTP Basic login is no longer used.
Removing that gateway login does not approve the development catalogue for redistribution;
review bundled assets before publishing a release that contains them.

## VM setup

The VM uses Ubuntu 24.04 x86-64, Docker Engine and the Compose plugin. Runtime applications
bind only to loopback; a separate `vthere-gateway` Compose project owns HTTP 80/8080 and
HTTPS 443/8443/9443. Preserve SSH access when managing these TCP firewall rules.
Do not expose Docker's socket or a database port over the network.

`deploy/gateway.Caddyfile` requests a Let's Encrypt IP certificate with the `shortlived`
profile. Caddy renews it automatically; its certificate volume must remain persistent.
Port 80 must remain reachable for ACME validation. This works without a purchased domain.
See [Let's Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
and [Caddy TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls).

Create a private gateway directory on the VM and copy `deploy/gateway.compose.yaml`,
`deploy/gateway.Caddyfile` and `deploy/.env.example` there. Rename the example to `.env`,
set `SITE_IP` and restrict the file to its owner. The app's `/login` page handles
sign-in; the gateway does not add HTTP Basic authentication. Protected account
pages redirect confirmed signed-out sessions to `/login`, while API requests retain
their normal 401/403 responses. Start the gateway from that directory:

```sh
docker compose -f gateway.compose.yaml up -d
```

When upgrading a gateway that used `SITE_USER` and `SITE_PASSWORD_HASH`, copy both
updated gateway files to this directory and recreate only the gateway service:

```sh
docker compose -f gateway.compose.yaml up -d --force-recreate gateway
```

The ordinary app deployment does not update this separate host gateway. Deploy the
matching frontend and API release as well; updating frontend code alone cannot
remove an HTTP Basic prompt served by an older gateway configuration.

Use a dedicated `vthere-runner` account for the self-hosted runner, with Docker access and
the custom `vthere-deploy` label. Install it as a system service using GitHub's runner setup
instructions. This runner executes manual deployment jobs only; CI checks run on
GitHub-hosted Ubuntu. Docker access grants control over the host: repository
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
For a server-inclusive release, also pass `-f current/compose.server.yaml` using its
absolute path before the command to include API, database and gateway services.
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

### Application folder move — 3 October 2026

The web package now lives in `apps/web/`. CI, Docker, the root launchers, asset loading,
architecture tooling and setup instructions use that location. All 79 tracked files
were preserved; application code, dependency manifests and asset bytes are unchanged.

Local Windows checks passed: lint, formatting, TypeScript, 189 unit tests, asset validation,
the launcher failure/success checks, architecture enforcement and all ten isolated module
removals, all four authoring browser suites, and development/production builds with their
build browser checks. Workflow YAML, referenced CI paths and Docker copy sources were also
checked. Asset validation retains the three existing distribution-licence warnings.

Docker is not installed on this machine, so the container build and packaged Caddy checks
remain for CI. No remote CI run or deployment was performed for this move.

### Visitor shortcut regression — 3 October 2026

The [failed dev CI run](https://github.com/Team-Meshworks/gam300/actions/runs/37038095171)
stopped at `Authoring resumes on exit`. An IndexedDB recovery backup could still be
pending after leaving Visitor mode, causing the shared keyboard handler to drop
Duplicate, Copy/Paste and Undo/Redo. Background backups now allow these edits;
Visitor mode and foreground file operations retain their keyboard guards.

The integration check holds a real backup's completion, verifies Visitor isolation,
then duplicates and undoes/redoes while the backup is pending. It also verifies that
edits made during the backup reach the next recovery record with their redo history.
This reproduced the original assertion before the fix and passed afterward.
Local lint, formatting, TypeScript, all 189 unit tests, and the integration and
history-recovery browser checks passed. CI still owns the Docker/Caddy verification.

### Deployed environments — 23 September 2026

Verified on 23 September 2026:

| Environment | Deployed commit                            | Successful CI                                                                    | Successful deployment                                                            |
| ----------- | ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Development | `f4ca18e725fdffaa4fa3beb1d78a5bba8026febc` | [35863197853](https://github.com/Team-Meshworks/gam300/actions/runs/35863197853) | [35865493351](https://github.com/Team-Meshworks/gam300/actions/runs/35865493351) |
| Production  | `4f5fa8c98e2556419d23b38f334b017280429feb` | [35864105358](https://github.com/Team-Meshworks/gam300/actions/runs/35864105358) | [35865630988](https://github.com/Team-Meshworks/gam300/actions/runs/35865630988) |

Both live sites passed the Chromium deployment check over trusted HTTPS with the team
login: editor loading, server policy, model/textures, placement and undo. Anonymous
requests to the application require authentication; public health/revision endpoints
report the expected commits. The later wiki setup moved Wiki.js to trusted HTTPS on
9443; HTTP 8080 redirects there. Both application version responses stayed unchanged.

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
