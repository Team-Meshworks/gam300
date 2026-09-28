# VThere Spatial Experience Editor

Spatial experience editor.

`dev` is the development integration branch; `main` is production. Both run automated
checks, and releases deploy manually from their matching branch. See
[development and deployment](docs/deployment.md) for Docker, CI, VM access and rollback.

The web app lives in `web/`. It is a React 19 + TypeScript single-page app built with Vite
(the project uses Vite 8, which swaps Rollup for rolldown internally).

## Prerequisites

- **Node.js `^24.19.0`** and **npm `^11.17.0`** (pinned in `web/.nvmrc` / `web/package.json`)
- The Vite stack **will not run on older Node versions** â€” Node 20.x and below fail with a
  `SyntaxError` / missing-native-binding error. Use Node 24.

### On Windows (nvm-windows)

```powershell
nvm install 24.19.0
nvm use 24.19.0
node -v   # -> v24.19.0
```

`nvm use` updates the `C:\Program Files\nodejs` junction, so it applies to every new terminal.
Note: some nvm-windows builds print no output at all â€” if that happens, upgrade nvm (see
Troubleshooting).

## Install

```powershell
cd web
npm ci
```

## Run the dev server

```powershell
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
