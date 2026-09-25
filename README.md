<h1 align="center">Spatial Experience Builder</h1>

<p align="center">
  <strong>A playful way to build interactive 3D spaces in the browser.</strong><br>
  Developed by Meshworks (Team 32) for VThere.
</p>

<p align="center">
  <a href="#project-status"><img src="https://img.shields.io/badge/status-M1_prototype-orange" alt="Status: M1 prototype"></a>
  <a href="https://github.com/Team-Meshworks/gam300/actions/workflows/ci.yml"><img src="https://github.com/Team-Meshworks/gam300/actions/workflows/ci.yml/badge.svg?branch=dev&amp;event=workflow_dispatch" alt="Latest manual CI run on dev"></a>
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

## Project status

**M1 prototype, under active development.** The interface and sample content are provisional.
Changes currently live in memory and are lost on reload or close; the editor displays
**Not saved** and warns before leaving a populated scene.

File import/export, local recovery, the WHEN → DO rule builder, accounts, PostgreSQL saving,
and publication/sharing are planned. The current visitor camera is part of the editor;
a separate visitor application is still to come. Sample asset distribution rights remain
under review; see the [asset pipeline notes](assets/README.md).

## Quick start

### Requirements

- Git with **Git LFS** for the 3D assets.
- **Node.js 24.19.0** and **npm 11.17.0** — the pinned toolchain in
  [`.nvmrc`](web/.nvmrc) and [`package.json`](web/package.json).
- A browser with **WebGL 2** support.

### Run locally

```sh
git lfs install
git clone --branch dev https://github.com/Team-Meshworks/gam300.git
cd gam300
git lfs pull
cd web
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173). The repository currently requires access to clone.
In the editor, choose **Open sample project**, select a crate, move it, and try **Undo**.
The sample-project button is available only in development builds.

For a container build, run `docker compose up --build --wait` from the repository root,
then open [localhost:8081](http://localhost:8081). See the
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

Use **Enter Visitor** and **Exit Visitor** to switch camera modes.

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

Run these commands from `web/`:

| Command                                             | Purpose                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `npm run dev`                                       | Start the development server with hot reload                   |
| `npm run build`                                     | Typecheck and build the editor into `web/dist/editor/`         |
| `npm run preview`                                   | Serve the production build locally                             |
| `npm run typecheck`                                 | Check TypeScript types                                         |
| `npm run lint`                                      | Run ESLint with zero warnings allowed                          |
| `npm run format:check`                              | Check formatting                                               |
| `npm run format`                                    | Apply formatting                                               |
| `npm run test:unit`                                 | Run the Vitest suite                                           |
| `npm run test:browser`                              | Check editor interactions against a running development server |
| `npm run test:deployment -- http://localhost:8081/` | Check the running container build                              |

For browser checks, install Chromium once with `npx playwright install chromium`.
Keep `npm run dev` running in one terminal, then run `npm run test:browser` in another.
Playwright is included in the locked development dependencies.

Validate asset metadata and GLBs from the repository root with
`node assets/tools/validate-assets.mjs`.

### Repository layout

```text
web/
  editor/            React UI, document state, viewport, and camera controls
  shared/            Asset catalogue, project types, validation, and fixtures
  tests/             Browser and deployment smoke checks
assets/
  source/            Original editable assets
  delivery/          Runtime models and thumbnails
  tools/             Asset validation
deploy/              Caddy configuration and deployment/rollback scripts
docs/                Deployment and wiki operations
.github/workflows/   Manual CI and deployment workflows
```

## CI and deployment

Both workflows use **manual dispatch only**. Pushes and pull requests do not start runs.

1. Open **Actions → CI → Run workflow** and select the branch to check.
2. Wait for lint, formatting, asset validation, unit tests, browser checks, and the container build.
3. A successful run on `dev` or `main` also publishes the tested image and a release descriptor.
   Other branches run checks without publishing an image.
4. To deploy, open **Actions → Deploy → Run workflow**, select the same branch, and enter
   the successful CI run ID. Deployment uses that exact tested image.

`dev` deploys to **development**; `main` deploys to **production**. Promote releases through
a `dev` → `main` pull request, then manually run CI on the resulting `main` commit.
The CI badge shows the latest manual run on `dev`, which may be older than its latest commit.

See the [deployment runbook](docs/deployment.md) for environment access, manual-run commands,
release validation, and rollback. GitHub's [manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
covers the Actions UI and required repository access.

## Contributing

1. Branch from `dev` and keep changes focused on one feature or fix.
2. Run type, lint, and formatting checks, plus the tests relevant to your change.
3. Open a pull request into `dev` with a summary, verification results, and screenshots for UI changes.
4. Ask a maintainer to run CI on the branch before merging; checks do not start automatically.

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
