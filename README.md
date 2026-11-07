<h1 align="center">Spatia</h1>

<p align="center">
  <strong>A playful way to build interactive 3D spaces in the browser.</strong><br>
  Developed by Meshworks (Team 32) for VThere.
</p>

<p align="center">
  <a href="#project-status"><img src="https://img.shields.io/badge/status-prototype-orange" alt="Status: prototype"></a>
  <a href="https://github.com/Team-Meshworks/gam300/actions/workflows/ci.yml"><img src="https://github.com/Team-Meshworks/gam300/actions/workflows/ci.yml/badge.svg?branch=dev&amp;event=push" alt="Latest push CI run on dev"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24"></a>
  <a href="apps/web/package.json"><img src="https://img.shields.io/badge/React-19-149ECA?logo=react&amp;logoColor=white" alt="React 19"></a>
  <a href="apps/web/package.json"><img src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript 6"></a>
  <a href="apps/web/package.json"><img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&amp;logoColor=white" alt="Vite 8"></a>
  <a href="apps/server/Spatia.Server/Spatia.Server.csproj"><img src="https://img.shields.io/badge/C%23-server-512BD4" alt="C# server"></a>
  <a href="apps/server/global.json"><img src="https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&amp;logoColor=white" alt=".NET 10"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#development">Development</a> ·
  <a href="#wiki">Wiki</a> ·
  <a href="#ci-and-deployment">CI &amp; deployment</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

**Spatia** is a browser creation tool for children and teenagers,
with educator support. The goal is to let authors arrange curated assets, add **WHEN → DO**
interactions without writing code, and share spaces that others can explore.

This repository contains the editor, visitor application and account and project API.

## Features

- **Build a 3D scene** — choose a room, then drag sample models into it or add them with a click or keyboard.
- **Edit objects** — select from the scene or object list, move with axis handles, and edit position, rotation and scale. Copy, paste, duplicate and delete objects with keyboard shortcuts.
- **Undo and redo** — reverse edits while preserving object identity.
- **Explore your scene** — switch between an orbit camera and a first-person visitor camera.
- **Load a sample project** — try a room, two crates, and a saved starting camera in development mode.
- **Recover from loading errors** — retry failed assets, with feedback when WebGL 2 is unavailable.
- **Save and reopen work** — recover a project from browser storage, or use Open, Save and Save As for project JSON files.
- **Work with server projects** — open authorised projects and autosave changes when the API is configured.
- **Publish an exhibition** — share a supported saved revision by link or QR code with selected signed-in viewers in the visitor application.
- **Validate project data** — TypeScript and C# support validation and cross-runtime round trips for versions 1 and 2 of the [project format](docs/project-format.md).

## Project status

**Prototype, under active development.** The interface and sample content are provisional.
Choose a room to create a saveable project. The editor quietly backs up the current session
in this browser and reopens it on reload, including valid undo history. **Saved** and
**Not saved** describe the JSON file; browser recovery does not mark that file as saved.

The project menu provides **New**, **Open**, **Save** and **Save As**. New/Open offers
**Save**, **Don’t Save** and **Cancel** when there are unsaved edits. Supported browsers
can update a chosen JSON file; after reload, Save reconnects its permission. Other browsers
use file upload/download and keep the file status unsaved because downloads have no completion
receipt. Save also retries a failed browser backup. Cancelled or failed operations preserve
the current scene. If an older backup is damaged, recovery asks before opening another readable
backup and keeps the damaged record.

The server implements Identity accounts and sessions, administrator provisioning, and authorised
PostgreSQL project workflows. When configured with the API, the editor can open and autosave
authorised server projects; browser recovery and JSON files remain available for local work.
See the [server guide](apps/server/README.md) for setup and the API boundary.

The editor includes a WHEN → DO interaction builder and preview. Supported saved projects can be
published for selected signed-in viewers in the separate visitor application. Preview and publication check player capabilities;
unsupported content and rules are preserved but cannot be played or published until supported.
Sample asset distribution rights remain under review; see the [asset pipeline notes](assets/README.md).

## Wiki

The [Spatia handbook](https://51.79.242.181:9443/en/home) contains
the team's project overview, setup, technical design, user guide and M1 evidence.

Edit pages directly in Wiki.js using **Edit Page**, then **Save**. Wiki.js automatically
pushes content every five minutes to this repository's
[`wiki` branch](https://github.com/Team-Meshworks/gam300/tree/wiki). That branch is a
content backup: changes made there do not sync back to the live wiki, and it must not
be merged into the application branches. See [wiki operations](docs/wiki.md) for
access, backups and recovery.

## Quick start

### Requirements

- Repository access and Git with **Git LFS** for the 3D assets.
- Docker with Linux containers and Docker Compose supporting `--wait`.
  Use [Docker Desktop for Windows 11](https://docs.docker.com/desktop/setup/install/windows-install/)
  or [macOS Tahoe](https://docs.docker.com/desktop/setup/install/mac-install/), or
  [Docker Engine on Ubuntu 24.04](https://docs.docker.com/engine/install/ubuntu/).
  Docker must be running and accessible to your user. Windows requires virtualization
  and the WSL 2 or Hyper-V backend. School installation restrictions may require an
  approved alternative machine or VM.
- A browser with **WebGL 2** support.

### Fresh clone to running application

After cloning this private repository, run one command from its root:

```sh
bash run.sh
```

On Windows, use:

```bat
run.bat
```

The launcher checks Git/Git LFS, Docker's Linux engine and Compose, restores delivery
assets, installs **Node 24.22.2/npm 11.21.1** inside the pinned container, runs `npm ci`,
lint, formatting, browser-policy and unit tests, and TypeScript/build checks.
Browser proof runs separately on a non-root sandbox-capable host and in CI,
including checks against the actual packaged application.
Only a successful build and its checks start the application. Failures print their stage
and return a nonzero exit code. Node, npm, Chrome and an application database do not
need to be installed on the host just to run the container. This launcher starts only the web service. It does not
start the API or PostgreSQL; server development and checks have separate prerequisites in the [server guide](apps/server/README.md).

Open [localhost:8081](http://localhost:8081). Stop with
`docker compose --project-name spatia-local down`. The first run downloads the locked
toolchain and packages. Later builds reuse Docker's cache. To force fresh
verification, use `docker compose --project-name spatia-local build --no-cache`, then
run the launcher. `APP_PORT` selects another local port; `COMPOSE_PROJECT_NAME`
selects an isolated local project. The launchers default to the M1 development build
with **Open sample project**. Set `BUILD_MODE=production` explicitly for the production
variant, which omits that control. `/version.txt` identifies the running build by its
commit, rather than a numbered product release.

The separate entry pages are available at `/landing` and `/login`; `/` continues to open
the editor. The web-only launcher does not start the account API. To use sign-in, follow
the [local API and PostgreSQL setup](docs/deployment.md#local-api-and-postgresql-integration):
set the private database passwords and start the combined Compose stack. Open
[https://localhost:8444/landing](https://localhost:8444/landing) or
[https://localhost:8444/login](https://localhost:8444/login). Caddy uses a local CA, so
the browser must trust its certificate. Sign-in requires a provisioned username; public
signup is unavailable. See the [private administrator bootstrap](apps/server/README.md#private-bootstrap-and-administrator-operations-part-4)
and provisioning instructions in the server guide. A verified session links to `/home`,
which loads authorised project and class workflows. Server-project creation depends on an
approved asset catalogue. The `/new-project`, `/classes`, `/review`, and `/organisations` routes
provide session-gated workflows backed by the configured API.

In the editor, add **test-room**, add **test-crate**, move it and try **Undo**.
Use the project menu's **Save** to save a JSON file. After editing, allow two seconds for
the quiet browser backup before reloading to check recovery.
**Open sample project** is available in the local development server and the `dev` VM build.
The `main` production build omits it. See [build modes](docs/deployment.md) to reproduce either
VM build locally.

The same Dockerfile is used by CI and deployment. See the
[deployment guide](docs/deployment.md#local-development) for prerequisites and details.

## Controls

| Mode    | Input                                                    | Action                             |
| ------- | -------------------------------------------------------- | ---------------------------------- |
| Editor  | Drag an asset / click or press Enter on its tile         | Place an object                    |
| Editor  | Select tool and click an object, or click its list entry | Select an object                   |
| Editor  | Drag a selected object's axis handle                     | Move along that axis               |
| Editor  | Right-drag an axis / selected object                     | Rotate on an axis / freely         |
| Editor  | Shift while rotating an axis                             | Snap rotation                      |
| Editor  | Scroll over a selected object                            | Scale it                           |
| Editor  | Position panel                                           | Edit position, rotation and scale  |
| Editor  | Ctrl/Cmd+C, V or D                                       | Copy, paste or duplicate selection |
| Editor  | Delete / Backspace                                       | Delete selection                   |
| Editor  | Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y               | Undo / redo                        |
| Editor  | Ctrl/Cmd+S / Ctrl/Cmd+Shift+S                            | Save / Save As                     |
| Editor  | Escape during placement or movement                      | Cancel the change                  |
| Editor  | Left-drag with Orbit / Pan / Zoom tool                   | Orbit / pan / zoom camera          |
| Editor  | Right-drag / scroll on background                        | Pan / zoom camera                  |
| Visitor | W / A / S / D                                            | Move forward / left / back / right |
| Visitor | Left mouse drag                                          | Look around                        |
| Visitor | Shift / Space / Ctrl                                     | Sprint / fly up / fly down         |

Viewport object picking and transforms require the Select tool. Choose Select, Orbit, Pan
or Zoom in the camera toolbar. Drag its grip to an edge, or
open the dock menu to choose an edge. Use **Preview** and **Exit preview** to switch camera modes. Authoring controls and
save shortcuts are inactive while visiting; movement stops when the window loses focus.

## Tech stack

| Area                  | Technology                                            |
| --------------------- | ----------------------------------------------------- |
| Interface             | React 19, TypeScript 6, native HTML and CSS           |
| 3D rendering          | Three.js with custom translation controls             |
| Server                | C#, ASP.NET Core 10, Identity, EF Core/Npgsql, PostgreSQL |
| Development and build | Vite 8, Node.js 24, npm                               |
| Quality checks        | Oxlint, Oxfmt, Vitest, Playwright, TUnit              |
| Delivery              | Docker, Caddy, GitHub Actions, Git LFS                |

The server has separate setup and checks; it is not required for the local-only editor.

## Development

For hot reload, install the pinned Node/npm versions in `apps/web/.nvmrc` and
`apps/web/package.json`, then run `npm --prefix apps/web ci` and `npm --prefix apps/web run dev`
from the root. The submission launcher above needs no host Node installation.
Vite development and preview serve `/landing` and `/login` through the separate entry
bundle and the workspace routes through their own bundle; packaged Caddy is configured
to serve the same routes. Run `npm run test:workspace -- <origin>` from `apps/web/` against
a running development server or built preview to check the workspace routes. For account integration
with hot reload, start the combined API stack above and configure `apps/web/.env.local`
using [the example](apps/web/.env.example). Set `SPATIA_API_ORIGIN` to
`https://localhost:8444`, `SPATIA_DEV_TLS_CERT` and `SPATIA_DEV_TLS_KEY` to a valid
trusted localhost certificate and private key in PEM format, and `SPATIA_API_CA` to the
local Caddy root certificate described in the deployment guide. Vite serves HTTPS and
proxies `/api` to that origin with certificate verification enabled. Keep these paths and
private keys out of source control; the settings use `SPATIA_`, not `VITE_`, and are not
client configuration. Without an API origin, `/api` returns a 503 response. The existing
account API handles cookies and CSRF. Clients use `/api/v1/...`; unversioned API
routes return 404 without redirects. Upgrade clients and server together. See the [server guide](apps/server/README.md#http-api-versioning)
for versioning and account setup.
Individual maintenance commands below run from `apps/web/`:

| Command                                             | Purpose                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                                       | Start the development server with hot reload                          |
| `npm run build`                                     | Typecheck and build the editor and visitor into `apps/web/dist/`       |
| `npm run preview`                                   | Serve the latest local build                                          |
| `npm run check:architecture`                        | Check source dependency boundaries                                    |
| `npm run test:architecture`                         | Test architecture enforcement                                         |
| `npm run typecheck`                                 | Check TypeScript types                                                |
| `npm run lint`                                      | Run Oxlint with zero warnings allowed                                 |
| `npm run format:check`                              | Check formatting                                                      |
| `npm run format`                                    | Apply formatting                                                      |
| `npm run test:unit`                                 | Run the Vitest suite                                                  |
| `npm run test:browser`                              | Check editor interactions against a running development server        |
| `npm run test:integration`                          | Check visitor isolation, loaded cameras, gizmos and edit cancellation |
| `npm run test:recovery`                             | Check place–move–undo–save–reload, file transfer and failure recovery |
| `npm run test:history`                              | Check recovered undo/redo and damaged-history handling                |
| `npm run test:viewpoints`                           | Check saved-view heading, capture and picker behavior                 |
| `npm run test:furniture-tools`                      | Check furniture placement, history and recovery                       |
| `npm run test:placement-collision`                  | Check room bounds and display placement collisions                    |
| `npm run test:moving-room-collision`                | Check room and object movement with collision constraints             |
| `npm run test:deployment -- http://localhost:8081/` | Check the running container build                                     |

Oxlint runs the upstream React Hooks JavaScript plugin to retain its compiler checks.
That plugin retains ESLint as an npm peer; `npm run lint` itself runs Oxlint. Validate
plugin compatibility when updating the lint configuration or dependencies.

Browser checks require a non-root user and official Google Chrome (or Chrome for
Testing) at least **157.0.8103.38**, the 3 November 2026 security-release floor.
From `apps/web/`, run `npm run browser:install` to install current official stable
Chrome and its system libraries, then `npm run browser:verify`. Installation may
keep an already-installed local Chrome. For updates, use Chrome's normal updater
or explicitly run `npm run browser:update` (this replaces the installed Chrome),
then repeat verification and the browser regression suite. The minimum floor is
not a promise of protection from future vulnerabilities. Release reference:
[Chrome stable security update](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop.html).

A custom official Chrome for Testing binary can be selected with `CHROME_PATH`.
An explicitly selected missing, stale or unrecognized binary fails closed; bundled
Playwright Chromium and old `PLAYWRIGHT_*` browser overrides are not fallbacks.
Remote Selenium overrides (`SELENIUM_REMOTE_*`) and context client certificates
are rejected because they can replace the verified browser or its local-only proxy.
The shared launcher verifies the installed version and Linux sandbox before loading
application content. On Linux, Chrome must report both process isolation and seccomp.
If the host cannot support that sandbox, use a sandbox-capable non-root host. Do not
add `--no-sandbox`, privileged containers, or weaken host security settings.

Keep `npm run dev` running in one terminal, then run `test:browser`, `test:integration`,
`test:recovery`, `test:history`, `test:viewpoints`, `test:furniture-tools`,
`test:placement-collision` and `test:moving-room-collision` with `npm run` in another.
All accept a loopback server URL, for example `npm run test:recovery -- http://127.0.0.1:5186/`.
Each browser is restricted to its explicitly selected local test origin through a
forwarding proxy, including redirects, popups and WebSockets; service workers are
blocked. Existing disposable HTTPS fixtures retain their local-only TLS exception.
`localhost` supports both IPv4 and IPv6 loopback without consulting DNS. CONNECT
tunnels enforce the exact approved host and port because tunnels do not expose a URL scheme.
The proxy does not use Playwright routing or disable HTTP caching, so the cache
benchmark remains meaningful. Persistent checks use temporary isolated profiles.

Run `npm run test:browser-policy` for policy/proxy/static-launch checks and
`npm run test:browser-security` for the real-browser sandbox, network and cache
regression. New test scripts must use `apps/web/tests/browser-security.mjs`.
After building, `node tools/check-browser.mjs` from the repository root exercises
the dev and built-preview suites. Browser proof runs outside Docker image builds:
the Docker build retains lint, formatting, policy, unit and compilation checks;
CI's non-root host checks the browser fixtures and the actual packaged application.
A successful image build alone is not browser evidence.

Validate asset metadata and GLBs from the repository root with
`node tools/validate-assets.mjs`. Run `node tools/validate-assets.check.mjs` to check
the validator itself. For the server, use the pinned .NET SDK 10.0.401 and follow the
[server toolchain and checks](apps/server/README.md#toolchain-and-checks), including its
disposable PostgreSQL prerequisites.

Run `npm run test:caching` in `apps/web/` against the development server to check asset cache
lifetime and shared resources. `npm run measure:caching` starts its own local server and
records comparable baseline/cached timings.

### Development environments and verification

The web npm workflow needs no application database, `.env` file, private local fixture or
Docker installation. Server integration checks have separate database and configuration
requirements. Access to this private repository and its Git LFS objects is required.
Use the pinned Node/npm versions above; if necessary install the matching npm with
`npm install --global npm@11.21.1`. On Windows, use `npm.cmd` / `npx.cmd` when PowerShell
blocks the `.ps1` launchers.

| Environment                | Setup and evidence                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 11                 | Fresh-clone native build and all browser checks passed on build 26200; launcher failure/startup checks also passed. Host Node was preinstalled for that native test.         |
| Ubuntu 24.04               | Clean GitHub Actions build/test/container checks; [baseline CI](https://github.com/Team-Meshworks/gam300/actions/runs/36964933555). Check the push run for the integrated commit on `dev` or `main`. |
| macOS Tahoe                | The workflow runs native setup, architecture, browser-policy and build checks on `macos-26`; lint, formatting and unit tests run on Ubuntu. Refer to the relevant `dev` or `main` push run for its actual result; no physical Mac test is claimed.        |
| Local Ubuntu 26.04 / WSL 2 | Root launcher passed with no native Node/npm, a fresh checkout and an empty isolated Docker build cache. Git LFS was configured in the test directory.                       |

For a clean reproduction, clone into a new directory and run the root launcher.
Record the commit, OS, Node/npm/browser versions and actual results when reporting a
setup problem. Existing CI evidence is tied to its commit; it does not verify later changes.

The [proposal](docs/proposal.md), [UI/UX exports](docs/design/ui-ux/README.md),
[architecture v0.1](docs/architecture.md) and [M1 deliverables](docs/deliverables.md)
connect product scope, component ownership and Jira work. The PDD is pending. The
[shared handbook](docs/wiki.md) contains broader project context.

### Repository layout

```text
run.bat / run.sh     One-command submission build, tests and startup
apps/
  web/
    editor/          React UI, document state, viewport, and camera controls
    visitor/         Published exhibition viewer
    shared/
      asset-runtime/ Asset catalogue contracts and model cache (TypeScript)
      project/       Project types, validation, and shared JSON fixtures
    tests/           Browser and deployment checks
  server/
    Spatia.Server/   ASP.NET Core accounts, project API, and persistence
    Spatia.ProjectFormat/  C# project format and validation
    tests/           TUnit API/database integration tests
    project-format-checks/  Standalone cross-runtime format checks
assets/
  source/            Original editable assets
  delivery/          Runtime models and thumbnails
deploy/              Caddy configuration and deployment/rollback scripts
tools/               Setup checks, offline asset validation and browser-check orchestration
docs/
  proposal.md        Product brief and scope
  design/            UI/UX exports; PDD pending
  architecture.md    Implemented and planned component boundaries
  project-format.md  Versioned project data contracts
  deliverables.md    M1 owners, statuses and Jira mapping
  deployment.md      Build, hosting and operational evidence
.github/workflows/   Automatic CI and manual deployment
```

Keep source with its owning application or feature; web unit tests live beside the
modules they exercise. The web and server `tests/` folders run different toolchains.
The standalone server format checker and API tests both read the fixtures in
`apps/web/shared/project/fixtures/`. See the [server setup](apps/server/README.md)
for its separate SDK, database and test prerequisites.

Root `assets/` contains the binary pipeline; `apps/web/shared/asset-runtime/` contains its
browser code. `source/` preserves originals and `delivery/` holds the manifest's runtime
files, even when an original and its delivery currently have identical bytes. Vite
loads catalogue assets from `assets/delivery/` and emits hashed URLs; do not copy them
into an editor public directory. Saved projects keep stable asset IDs.

`node_modules/`, `bin/`, `obj/`, `apps/web/dist/`, `test-results/`, `ci-artifacts/`,
`outputs/` and `.artifacts/` are ignored local dependencies, build output or check
evidence. Repeated output-folder names belong to their invoking tools; they are not
additional source trees. Root `test-results/` holds repository checks and disposable
architecture copies; application check reports stay under that application's
`test-results/`. Preserve retained evidence when cleaning local output. Local handoff
material under `docs/personal/` is also ignored and is separate from shared docs.

## CI and deployment

CI runs automatically only on pushes to `dev` or `main`, including merge commits.
Opening or updating a pull request does not start CI. Manual CI is supported only
on `dev` or `main`; selecting another branch skips all jobs.
Pull requests into `main` must still come from this repository's `dev` branch.
Reviewers must verify that source before merging because CI no longer enforces it.
Deployment remains a separate manual action.

1. Run the relevant checks locally and obtain review before merging into `dev`. The
   resulting push starts CI. For an extra run, open **Actions > CI > Run workflow**
   and select `dev` or `main`.
2. Wait for web lint, formatting, architecture and asset validation, unit and browser checks,
   native Windows/macOS checks, the Ubuntu container checks, shared project-format checks,
   and server build and tests against disposable PostgreSQL.
3. Successful push/manual runs on `dev` or `main` publish the tested web, API and migration
   images and a release descriptor. Feature branches receive no automatic CI runs or published images.
4. To deploy, open **Actions > Deploy > Run workflow**, select the same branch, and enter
   the successful CI run ID. Deployment uses the tested images and applies migrations to the
   retained application database; see the runbook for backup and recovery details.

`dev` deploys to **development**; `main` deploys to **production**. Promote releases through
a `dev` to `main` pull request; the resulting push runs CI on the integrated `main` commit.
The CI badge shows the latest push run on `dev`.

See the [deployment runbook](docs/deployment.md) for environment access, manual-run commands,
release validation, and rollback. GitHub's [manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
covers the Actions UI and required repository access.

## Contributing

1. Branch from `dev` and keep changes focused on one feature or fix.
2. Run type, lint, and formatting checks, plus the tests relevant to your change.
3. Open a pull request into `dev` with a summary, verification results, and screenshots for UI changes.
4. Obtain reviewer approval based on the local verification results, then merge into `dev`.
5. Check the resulting `dev` CI run before promoting through a `dev` to `main` pull request.

Report bugs through [GitHub Issues](https://github.com/Team-Meshworks/gam300/issues), including
reproduction steps, expected behavior, and browser/OS details. For asset changes, include
provenance and follow the [asset pipeline](assets/README.md).

## Troubleshooting

| Problem                                          | What to check                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Missing or unreadable 3D models                  | Run `git lfs pull` from the repository root.                                                                 |
| Node or native-binding errors                    | Check `node --version` and `npm --version` against the pinned toolchain, then rerun `npm ci` in `apps/web/`. |
| PowerShell blocks `npm.ps1`                      | Use `npm.cmd` instead of `npm`, and `npx.cmd` instead of `npx`.                                              |
| Chrome browser preflight fails                  | Run `npm run browser:install` and `npm run browser:verify` from `apps/web/` on a non-root sandbox-capable host. |
| The viewport reports that WebGL 2 is unavailable | Check browser graphics support and hardware acceleration.                                                    |

## Performance check (T02)

Tested **2 October 2026** on an **X870 AORUS ELITE WIFI7 desktop** with specs:

- CPU: Ryzen 7 7800X3D
- GPU: RTX 5070
- Memory: 32 GB RAM
- OS: Windows 11
- Browser: Edge 154.0.4258.48

Local production build at
1366 × 768, using the sample room and two crates.

| Measurement                         | Result                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Load time, median of five runs      | 185 ms cold; 175 ms cached                                                   |
| Frame time, measured for 30 seconds | 5.6 ms median (about 180 FPS); 99% within 5.7 ms                             |
| Resource use                        | 6.4 MB JavaScript memory; 22 geometry resources, 4 textures and 8 draw calls |

Resource counts stayed unchanged through **10 scene replacements**. Missing-asset retry passed.

## License

No project license is currently included in this repository. Asset provenance and licensing
are tracked separately in [`assets/manifest.json`](assets/manifest.json) and the
[asset pipeline notes](assets/README.md).
