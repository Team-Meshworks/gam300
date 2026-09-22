# VThere

Spatial experience editor.

The web app lives in `web/`. It is a React 19 + TypeScript single-page app built with Vite
(the project uses Vite 8, which swaps Rollup for rolldown internally).

## Project setup

### Prerequisites

- **Node.js `^24.19.0`** and **npm `^11.17.0`** (pinned in `web/.nvmrc` / `web/package.json`)
- The Vite stack **will not run on older Node versions** — Node 20.x and below fail with a
  `SyntaxError` / missing-native-binding error. Use Node 24.

#### On Windows (nvm-windows)

```powershell
nvm install 24.19.0
nvm use 24.19.0
node -v   # -> v24.19.0
```

`nvm use` updates the `C:\Program Files\nodejs` junction, so it applies to every new terminal.
Note: some nvm-windows builds print no output at all — if that happens, upgrade nvm (see
Troubleshooting).

### Install

```powershell
cd web
npm install
```

### Run the dev server

```powershell
cd web
npm run dev
```

Vite serves the editor at http://localhost:5173/ with hot reload.

### Common scripts

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

## Controls

### Editor mode (orbital camera)

| Input               | Action |
| ------------------- | ------ |
| Left-drag           | Rotate |
| Right-drag          | Pan    |
| Scroll wheel        | Zoom   |

### Visitor mode (first-person camera)

| Input                       | Action                            |
| --------------------------- | --------------------------------- |
| `W` / `A` / `S` / `D`       | Move forward / left / back / right |
| Mouse drag (left button)    | Look around                       |
| `Shift`                     | Sprint                            |
| `Space`                     | Fly up                            |
| `Ctrl`                      | Fly down                          |

Toggle between modes with the **Enter Visitor** / **Exit Visitor** button.

## Project layout

```
web/
  editor/          Vite root: index.html, main.tsx, App.tsx, styles.css
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