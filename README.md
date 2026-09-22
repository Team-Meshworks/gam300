# VThere Spatial Experience Editor

Spatial experience editor.

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
npm install
```

## Run the dev server

```powershell
cd web
npm run dev
```

Vite serves the editor at http://localhost:5173/ with hot reload.

## Current editor behavior

The asset library shows a thumbnail rendered from the existing snow-globe model. Drag it
onto the scene's ground grid, or click/press Enter to add it at the center. Each placement
creates one object with a stable ID and one undo step. Select objects through the scene
or its object list; Undo/Redo preserve identity and ordering. Escape or a drop outside
the scene cancels placement. Errors offer Retry, and the interface respects reduced motion.

This is an in-memory authoring slice. Changes are not saved; the header reports that and
leaving the page with placed objects triggers the browser's unsaved-work prompt. The full
project format, approved asset registry, custom movement and persistence remain unfinished.
Picking currently uses object bounds; full mesh picking and camera navigation are still
part of viewport work. Import/export controls will appear when those features work.

Run the project-data and document-store checks from `web/`:

```powershell
npm run test:unit
```

The document store can load validated JSON through `loadProject(text, assetKinds)`
where `assetKinds` maps catalog IDs to their asset kinds
Successful loading replaces the project and clears placement history
Rejected loading preserves the current snapshot and history
The snapshot's `project` is null in the initial grid-only editor until a complete
project is loaded; environment/catalog rendering and file controls still need integration

With the dev server running, use an existing Playwright installation with Chromium:

```powershell
cd web
# Omit this variable if Playwright is already resolvable from web/
$env:PLAYWRIGHT_MODULE = 'C:\path\to\node_modules\playwright\index.mjs'
node tests/editor-shell.smoke.mjs
```

The check covers thumbnails, keyboard and drag placement, shared selection, undo/redo,
cancellation, rejection of unknown drops, layout at 1366, 1024, 760 and 320 CSS pixels,
reduced motion, one canvas under Strict Mode, failed asset loading/retry and WebGL fallback.
Pass a different server URL as the first argument. This uses external browser-test tooling;
Playwright is not a project dependency or a configured CI job yet.

## Common scripts

All commands run from `web/`.

| Command              | What it does                                        |
| -------------------- | --------------------------------------------------- |
| `npm run dev`        | Start the dev server (HMR)                          |
| `npm run build`      | Typecheck then production build                     |
| `npm run typecheck`  | `tsc -b` typecheck only                             |
| `npm run preview`    | Serve the production build locally                  |
| `npm run lint`       | ESLint (zero warnings allowed)                      |
| `npm run format`     | Prettier write                                      |
| `npm run format:check` | Prettier check                                   |

## Project layout

```
web/
  editor/          Vite root: index.html, main.tsx, App.tsx, styles.css
  shared/          Plain object types and the existing sample asset descriptor
  vite.config.ts   Rooted at ./editor; builds to ../dist/editor
  tsconfig*.json
  eslint.config.js
  .prettierrc.json
```

## Troubleshooting

### `SyntaxError: ... does not provide an export named 'styleText'`

Your Node is too old. Install and use Node 24 (see Prerequisites). The project's Node 18/20.x
dependency pins are not compatible with older runtimes.

### `Error: Cannot find native binding` (rolldown)

`node_modules` was installed with a different Node version, so the platform-specific rolldown
binding is missing. Reinstall from scratch:

```powershell
cd web
Remove-Item -Recurse -Force node_modules
npm install
```

### `nvm` prints nothing / `nvm: command not found`

The current nvm-windows release re-shipped a broken `nvm.exe`. Reinstall or replace the binary
at `%APPDATA%\nvm\nvm.exe` from the latest release, then `nvm use 24.19.0` again.

### `npm.ps1 cannot be loaded because running scripts is disabled`

npm ships a `.ps1` wrapper. If PowerShell blocks it, allow local scripts once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Then reopen the terminal.
