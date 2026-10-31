# Development and production

| Branch | GitHub environment | VM URL                     | Private application port |
| ------ | ------------------ | -------------------------- | ------------------------ |
| `dev`  | `development`      | https://51.79.242.181:8443 | `127.0.0.1:8082`         |
| `main` | `production`       | https://51.79.242.181      | `127.0.0.1:8081`         |

Integrate feature work into `dev`. Release through a `dev` to `main` pull request.
CI runs automatically only after pushes to `dev` or `main`, including merge commits.
Pull requests do not start CI. Manual CI dispatch is supported only on those two
branches; selecting another branch skips all jobs. Deployment is a separate manual
action and never rebuilds the image.

The promotion rule still requires a PR into `main` to come from this repository's
`dev` branch. Removing PR-triggered CI also removes its automatic source-branch
check, so reviewers must verify the source repository and branch before merging.
This is a manual safeguard, not an equivalent automated enforcement mechanism.
The GitHub environments allow only their matching branches.

CI builds `dev` with `NODE_ENV=development` and Vite's `development` mode, including
**Open sample project** and framework development diagnostics. `main` uses
`NODE_ENV=production` and `production` mode. Manual runs use the selected supported
branch's mode. Both images contain built
static files served by Caddy, with the same health checks, access gate and rollback.
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
This M1 deployment contains the editor only. PostgreSQL and the application API remain M2
work; Wiki.js's database is not the application database. Browser storage belongs to each
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
build runs lint, formatting, unit tests, TypeScript, all four authoring browser suites
and the packaged-build browser checks before the web service starts. CI sets
`RUN_BUILD_CHECKS=false` after its source checks pass, then tests the final Caddy image;
standalone builds retain all checks by default. Host Node/npm
and Playwright are unnecessary. API/PostgreSQL services remain M2 implementation work.
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
npx playwright install chromium
```

With the container running:

```sh
npm run test:deployment -- http://localhost:8081/
```

For these checks without host Node or Chromium, use the same Dockerfile's `build`
stage. From the repository root in PowerShell, with the development container running:

```powershell
docker build --load --target build --build-arg BUILD_MODE=development -t spatia-checks:local .
$checkContainer = docker compose --project-name spatia-local ps -q web
docker run --rm --network "container:$checkContainer" spatia-checks:local node tests/deployment.check.mjs http://127.0.0.1:8080/
docker run --rm --network "container:$checkContainer" -e BUILD_MODE=development spatia-checks:local node tests/editor-build.check.mjs http://127.0.0.1:8080/
```

In Bash, use `check_container=$(docker compose --project-name spatia-local ps -q web)`
and `--network "container:$check_container"`. This connects the test browser to Caddy's
network namespace, keeping the URL on loopback and file/recovery APIs available.
For production, select `production` in both the build argument and test environment.
The deployment check exercises place/move/undo, JSON Save/Open, reload and recovered
undo through the packaged UI. The four source-level authoring suites still run against
Vite during the Docker build; they import source modules that Caddy must not serve.

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
images needed for rollback; deleting their tags can make old releases unavailable.
Feature branches do not run these checks in Actions; run the relevant checks locally
before requesting review.

Superseded CI runs are cancelled. Deployments are serialized per environment, and a VM
file lock also prevents concurrent changes to the same deployment.

### Run CI on demand

Open **Actions > CI > Run workflow**, select `dev` or `main`, then choose **Run workflow**.
With an authenticated GitHub CLI, the equivalent is:

```sh
gh workflow run ci.yml --ref dev
```

Choose `dev` for a development release or `main` for a production release.
Feature-branch checks must be run locally. Merging into either supported branch automatically runs CI
on the resulting commit; deployment consumes the selected run's commit, not the latest branch contents.

Manual dispatch requires repository write access, and the workflow must exist on the
default branch. Workflow changes follow the same feature to dev to main promotion path.
See GitHub's
[manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Deploy or roll back

1. Wait for the intended branch's push CI run, manually run **CI**, or choose an existing
   successful run for rollback. Copy its run ID from the summary
   or the number at the end of its GitHub URL.
2. Open **Actions > Deploy > Run workflow**.
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
set the address/login and generate the password hash with the pinned Caddy image's
`caddy hash-password` command. Preserve single quotes around the hash in `.env` so Compose
does not interpolate its dollar signs. Keep the password outside Git and restrict the file
to its owner. Start the gateway from that directory:

```sh
docker compose -f gateway.compose.yaml up -d
```

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
