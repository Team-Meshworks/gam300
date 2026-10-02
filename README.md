<h1 align="center">Spatial Experience Builder</h1>

<p align="center">
  <strong>A playful way to build interactive 3D spaces in the browser.</strong><br>
  Developed by Meshworks (Team 32) for VThere.
</p>

<p align="center">
  <a href="#project-status"><img src="https://img.shields.io/badge/status-M1_prototype-orange" alt="Status: M1 prototype"></a>
  <a href="https://github.com/Team-Meshworks/gam300/actions/workflows/ci.yml"><img src="https://github.com/Team-Meshworks/gam300/actions/workflows/ci.yml/badge.svg?branch=dev&amp;event=push" alt="Latest push CI run on dev"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24"></a>
  <a href="web/package.json"><img src="https://img.shields.io/badge/React-19-149ECA?logo=react&amp;logoColor=white" alt="React 19"></a>
  <a href="web/package.json"><img src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript 6"></a>
  <a href="web/package.json"><img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&amp;logoColor=white" alt="Vite 8"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#development">Development</a> ·
  <a href="#ci-and-deployment">CI &amp; deployment</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

**Spatial Experience Builder (SEB)** is a browser creation tool for children and teenagers,
with educator support. The goal is to let authors arrange curated assets, add **WHEN → DO**
interactions without writing code, and share spaces that others can explore.

This repository currently contains the editor prototype. **Meshworks** is the development
team; **VThere** is the commissioning company.

## Features

- **Build a 3D scene** — drag sample models onto the ground grid, or add them with a click or keyboard.
- **Select and move objects** — use the scene or object list, custom axis handles, and movement buttons.
- **Undo and redo** — reverse object placement and movement while preserving object identity.
- **Explore your scene** — switch between an orbit camera and a first-person visitor camera.
- **Load a sample project** — try a room, two crates, and a saved starting camera in development mode.
- **Recover from loading errors** — retry failed assets, with feedback when WebGL 2 is unavailable.
- **Save and reopen work** — recover a project from browser storage, or use Open, Save and Save As for project JSON files.

## Project status

**M1 prototype, under active development.** The interface and sample content are provisional.
Choose a room to create a saveable project. The editor quietly backs up the current session
in this browser and reopens it on reload, including valid undo history. **Saved** and
**Not saved** describe the JSON file; browser recovery does not mark that file as saved.
Loose objects on the initial grid need a room before they can be saved as a project.

The project menu provides **New**, **Open**, **Save** and **Save As**. New/Open offers
**Save**, **Don’t Save** and **Cancel** when there are unsaved edits. Supported browsers
can update a chosen JSON file; after reload, Save reconnects its permission. Other browsers
use file upload/download and keep the file status unsaved because downloads have no completion
receipt. Save also retries a failed browser backup. Cancelled or failed operations preserve
the current scene. If an older backup is damaged, recovery asks before opening another readable
backup and keeps the damaged record.

The WHEN → DO rule builder, accounts, PostgreSQL saving and publication/sharing are planned.
The current visitor camera is part of the editor;
a separate visitor application is still to come. Sample asset distribution rights remain
under review; see the [asset pipeline notes](assets/README.md).

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
assets, installs **Node 24.19.0/npm 11.17.0** inside the pinned container, runs `npm ci`,
lint, formatting, unit tests, TypeScript/build checks,
all four authoring browser suites and the production/development build browser check.
Only a successful build and tests start the application. Failures print their stage
and return a nonzero exit code. Node, npm, Chromium and an application database do not
need to be installed on the host. The current M1 application requires only the web
service; the API and PostgreSQL will join this command when implemented in M2.

Open [localhost:8081](http://localhost:8081). Stop with
`docker compose --project-name seb-local down`. The first run downloads the locked
toolchain, packages and browser. Later builds reuse Docker's cache. To force fresh
verification, use `docker compose --project-name seb-local build --no-cache`, then
run the launcher. `APP_PORT` selects another local port; `COMPOSE_PROJECT_NAME`
selects an isolated local project. The launchers default to the M1 development build
with **Open sample project**. Set `BUILD_MODE=production` explicitly for the production
variant, which omits that control. `/version.txt` reports the checkout commit.

In the editor, add **test-room**, add **test-crate**, move it and try **Undo**.
Use the project menu's **Save** to save a JSON file. After editing, allow two seconds for
the quiet browser backup before reloading to check recovery.
**Open sample project** is available in the local development server and the `dev` VM build.
The `main` production build omits it. See [build modes](docs/deployment.md) to reproduce either
VM build locally.

The same Dockerfile is used by CI and deployment. See the
[deployment guide](docs/deployment.md#local-development) for prerequisites and details.

## Controls

| Mode    | Input                                             | Action                             |
| ------- | ------------------------------------------------- | ---------------------------------- |
| Editor  | Drag an asset / click or press Enter on its tile  | Place an object                    |
| Editor  | Click an object or its entry in the scene list    | Select an object                   |
| Editor  | Drag a selected object's axis handle              | Move along that axis               |
| Editor  | X / Y / Z movement buttons                        | Move in 0.25 m steps               |
| Editor  | Escape during placement or movement               | Cancel the change                  |
| Editor  | Left-drag away from handles / right-drag / scroll | Orbit / pan / zoom                 |
| Visitor | W / A / S / D                                     | Move forward / left / back / right |
| Visitor | Left mouse drag                                   | Look around                        |
| Visitor | Shift / Space / Ctrl                              | Sprint / fly up / fly down         |

Use **Enter Visitor** and **Exit Visitor** to switch camera modes. Authoring controls and
save shortcuts are inactive while visiting; movement stops when the window loses focus.

## Tech stack

| Area                  | Technology                                  |
| --------------------- | ------------------------------------------- |
| Interface             | React 19, TypeScript 6, native HTML and CSS |
| 3D rendering          | Three.js with custom translation controls   |
| Development and build | Vite 8, Node.js 24, npm                     |
| Quality checks        | ESLint, Prettier, Vitest, Playwright        |
| Delivery              | Docker, Caddy, GitHub Actions, Git LFS      |

ASP.NET Core/Identity and PostgreSQL via EF Core/Npgsql are planned for the application
backend. They are not required to run the current editor.

## Development

For hot reload, install the pinned Node/npm versions in `web/.nvmrc` and
`web/package.json`, then run `npm --prefix web ci` and `npm --prefix web run dev`
from the root. The submission launcher above needs no host Node installation.
Individual maintenance commands below run from `web/`:

| Command                                             | Purpose                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                                       | Start the development server with hot reload                          |
| `npm run build`                                     | Typecheck and build the editor into `web/dist/editor/`                |
| `npm run preview`                                   | Serve the latest local build                                          |
| `npm run typecheck`                                 | Check TypeScript types                                                |
| `npm run lint`                                      | Run ESLint with zero warnings allowed                                 |
| `npm run format:check`                              | Check formatting                                                      |
| `npm run format`                                    | Apply formatting                                                      |
| `npm run test:unit`                                 | Run the Vitest suite                                                  |
| `npm run test:browser`                              | Check editor interactions against a running development server        |
| `npm run test:integration`                          | Check visitor isolation, loaded cameras, gizmos and edit cancellation |
| `npm run test:recovery`                             | Check place–move–undo–save–reload, file transfer and failure recovery |
| `npm run test:history`                              | Check recovered undo/redo and damaged-history handling                |
| `npm run test:deployment -- http://localhost:8081/` | Check the running container build                                     |

For browser checks, install Chromium once with `npx playwright install chromium`.
Keep `npm run dev` running in one terminal, then run `test:browser`, `test:integration`,
`test:recovery` and `test:history` with `npm run` in another. All accept a different server URL, for example
`npm run test:recovery -- http://127.0.0.1:5186/`.
Playwright is included in the locked development dependencies.

On Ubuntu, use `npx playwright install --with-deps chromium` to install Chromium's
system libraries as well. See [Playwright's CI instructions](https://playwright.dev/docs/ci).

Validate asset metadata and GLBs from the repository root with
`node assets/tools/validate-assets.mjs`.

### Development environments and verification

The npm workflow needs no application database, `.env` file, private local fixture or
Docker installation. Access to this private repository and its Git LFS objects is required.
Use the pinned Node/npm versions above; if necessary install the matching npm with
`npm install --global npm@11.17.0`. On Windows, use `npm.cmd` / `npx.cmd` when PowerShell
blocks the `.ps1` launchers.

| Environment                | Setup and evidence                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 11                 | Fresh-clone native build and all browser checks passed on build 26200; launcher failure/startup checks also passed. Host Node was preinstalled for that native test.         |
| Ubuntu 24.04               | Clean GitHub Actions build/test/container checks; [baseline CI](https://github.com/Team-Meshworks/gam300/actions/runs/36964933555). The current PR must pass its own checks. |
| macOS Tahoe                | The workflow requires native install/type/build/lint/unit/setup checks on `macos-26`. Refer to the current PR for its actual result; no physical Mac test is claimed.        |
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
web/
  editor/            React UI, document state, viewport, and camera controls
  shared/            Asset catalogue, project types, validation, and fixtures
  tests/             Browser and deployment checks
assets/
  source/            Original editable assets
  delivery/          Runtime models and thumbnails
  tools/             Asset validation
deploy/              Caddy configuration and deployment/rollback scripts
tools/               Browser-check orchestration
docs/
  proposal.md        Product brief and scope
  design/            UI/UX exports; PDD pending
  architecture.md    Implemented and planned component boundaries
  deliverables.md    M1 owners, statuses and Jira mapping
  planning/          Supplied feature/deliverable planning workbooks
  deployment.md      Build, hosting and operational evidence
.github/workflows/   Automatic CI and manual deployment
```

## CI and deployment

CI runs automatically on pushes to `dev`/`main` and pull requests targeting either branch.
Pull requests into `main` must come from this repository's `dev` branch.
Deployment remains a separate manual action.

1. Open a pull request into `dev`; its CI checks start automatically. For an extra run,
   open **Actions → CI → Run workflow** and select the branch.
2. Wait for lint, formatting, asset validation, unit tests, editor/integration/recovery/history checks,
   native Windows/macOS checks, and the container build and checks on Ubuntu 24.04.
3. Successful push/manual runs on `dev` or `main` publish the tested image and a release
   descriptor. Pull request runs and manual runs on feature branches do not publish images.
4. To deploy, open **Actions → Deploy → Run workflow**, select the same branch, and enter
   the successful CI run ID. Deployment uses that exact tested image.

`dev` deploys to **development**; `main` deploys to **production**. Promote releases through
a `dev` → `main` pull request; the resulting push runs CI on the integrated `main` commit.
The CI badge shows the latest push run on `dev`.

See the [deployment runbook](docs/deployment.md) for environment access, manual-run commands,
release validation, and rollback. GitHub's [manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
covers the Actions UI and required repository access.

## Contributing

1. Branch from `dev` and keep changes focused on one feature or fix.
2. Run type, lint, and formatting checks, plus the tests relevant to your change.
3. Open a pull request into `dev` with a summary, verification results, and screenshots for UI changes.
4. Obtain reviewer approval and wait for passing CI before merging. GitHub branch protection
   is unavailable on the current private-repository plan, so maintainers enforce this step.

Report bugs through [GitHub Issues](https://github.com/Team-Meshworks/gam300/issues), including
reproduction steps, expected behavior, and browser/OS details. For asset changes, include
provenance and follow the [asset pipeline](assets/README.md).

## Troubleshooting

| Problem                                          | What to check                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Missing or unreadable 3D models                  | Run `git lfs pull` from the repository root.                                                            |
| Node or native-binding errors                    | Check `node --version` and `npm --version` against the pinned toolchain, then rerun `npm ci` in `web/`. |
| PowerShell blocks `npm.ps1`                      | Use `npm.cmd` instead of `npm`, and `npx.cmd` instead of `npx`.                                         |
| Playwright cannot find Chromium                  | Run `npx playwright install chromium` from `web/`.                                                      |
| The viewport reports that WebGL 2 is unavailable | Check browser graphics support and hardware acceleration.                                               |

## License

No project license is currently included in this repository. Asset provenance and licensing
are tracked separately in [`assets/manifest.json`](assets/manifest.json) and the
[asset pipeline notes](assets/README.md).
