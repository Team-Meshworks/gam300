---
title: Getting Started
description: Clone, install, run and check the current SEB development branch.
published: true
date: 2026-10-02T14:47:06.594Z
tags: 
editor: markdown
dateCreated: 2026-09-23T13:58:12.443Z
---

# Getting started

This guide targets the published **dev** branch at **8f05c07**, reviewed on 2 October 2026. The browser application lives in **web/**. Application backend and PostgreSQL setup are future M2 work; you do not need the Wiki.js database to run this editor.

## Prerequisites

- Access to the private [GitHub repository](https://github.com/Team-Meshworks/gam300).
- Git and Git LFS.
- Node.js **24.19.0** and npm **11.17.0**, matching web/.nvmrc and web/package.json. Recheck the pins after switching branches.
- A desktop browser with WebGL 2 support.
- Docker Desktop with Linux containers/WSL 2 on Windows only if using the optional container workflow.

## Clone and install

Run these commands in a terminal. Preserve uncommitted work before switching an existing checkout.

~~~sh
git lfs install
git clone --branch dev https://github.com/Team-Meshworks/gam300.git
cd gam300
git lfs pull
cd web
node --version
npm --version
npm ci
~~~

Git LFS fetches the model bytes; a small text pointer is not a usable GLB. npm ci installs the committed lockfile. Playwright is included in the development dependencies.

## Run the editor

From web/:

~~~sh
npm run dev
~~~

Open [http://localhost:5173/](http://localhost:5173/) or Vite's printed URL. Leave this terminal running. **Open sample project** is available in the local development server and the hosted dev build; production builds omit it.

Follow [Using SEB](/en/user-guide): add **test-room**, add **test-crate**, move it, Undo/Redo and Save a project JSON file. After editing, allow two seconds for the quiet browser backup, then reload to check recovery. Browser recovery and the JSON file's Saved/Not saved status are separate.

## Build and check

Run from web/:

| Command | Purpose |
| --- | --- |
| npm run typecheck | Check TypeScript |
| npm run lint | Lint with zero warnings allowed |
| npm run format:check | Check formatting without changing files |
| npm run test:unit | Run Vitest domain/editor tests |
| npm run build | Typecheck and build into web/dist/editor/ |
| npm run preview | Serve the built editor; open its printed URL |
| npx playwright install chromium | Install the locked browser test runtime once |
| npm run test:browser | Check authoring interactions against the running dev server |
| npm run test:integration | Check visitor isolation, cameras, gizmos and cancellation |
| npm run test:recovery | Check local backup, project files and safe failure handling |
| npm run test:history | Check recovered Undo/Redo and damaged history |

Keep npm run dev running in one terminal and run the four browser suites in another. They accept a different server URL, for example **npm run test:recovery -- http://127.0.0.1:5186/**. On Ubuntu use **npx playwright install --with-deps chromium** to include system libraries.

From the repository root, **node assets/tools/validate-assets.mjs** validates asset metadata and GLBs. See [Testing and milestone evidence](/en/testing) for recorded results and Fxx/Txx/Rxx mappings.

## Optional container workflow

From the repository root, with Docker running:

~~~sh
docker compose up --build --wait
~~~

Open [http://localhost:8081/](http://localhost:8081/). This uses the production build mode by default. Follow the tracked [build-mode instructions](https://github.com/Team-Meshworks/gam300/blob/dev/docs/deployment.md) to reproduce the dev build, which includes development controls.

From web/, check the running container with **npm run test:deployment -- http://localhost:8081/**. Stop the local application from the repository root with **docker compose down**. On the shared VM use the scoped [deployment runbook](/en/deployment).

## Supported setup evidence

The published [dev README](https://github.com/Team-Meshworks/gam300/blob/dev/README.md) records Windows 11 x64/PowerShell verification and Ubuntu 24.04 x64 CI verification. **macOS has not been verified**. The same terminal workflow is documented for it, without claiming a compatibility pass. The current [CI result](/en/testing) is tied to 8f05c07; it does not verify later commits.

For a clean reproduction, use a new directory, run the commands above, build, then open the preview URL. Record the commit, OS, Node/npm/browser versions and actual results.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Node/Vite native-binding or syntax errors | Confirm Node/npm pins, then rerun npm ci from web/. |
| Missing or unreadable models | Run git lfs pull and check repository/LFS access. |
| PowerShell blocks npm.ps1 or npx.ps1 | Use npm.cmd and npx.cmd with the same arguments. |
| Port 5173 already in use | Use Vite's printed URL and pass it to browser checks. |
| WebGL unavailable | Check supported browser graphics and record the displayed fallback. |
| Demo asks for a login | VM application access is separate from GitHub and Wiki.js; ask the team administrator. |

## Source of truth

[Published dev README](https://github.com/Team-Meshworks/gam300/blob/dev/README.md), [package scripts](https://github.com/Team-Meshworks/gam300/blob/dev/web/package.json), [Node pin](https://github.com/Team-Meshworks/gam300/blob/dev/web/.nvmrc), [architecture v0.1](https://github.com/Team-Meshworks/gam300/blob/dev/docs/architecture.md) and the [tracked deployment runbook](https://github.com/Team-Meshworks/gam300/blob/dev/docs/deployment.md) take precedence over old copied setup notes.

[Using SEB](/en/user-guide) · [Testing and evidence](/en/testing) · [Handbook](/en/home)

_Last reviewed: 2 October 2026 against published dev 8f05c07. Existing CI results were inspected; no new application-suite run is claimed for this wiki update._
