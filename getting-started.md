---
title: Getting Started
description: Clone, install, run and check the current VThere development branch.
published: true
date: 2026-09-23T13:58:12.443Z
tags: 
editor: markdown
dateCreated: 2026-09-23T13:58:12.443Z
---

# Getting started

This guide targets the current **dev** branch. The browser application lives in **web/**. Application backend and PostgreSQL setup are future M2 work; you do not need the Wiki.js database to run this editor.

## Prerequisites

- Access to the private [GitHub repository](https://github.com/Team-Meshworks/gam300).
- Git and Git LFS.
- Node.js **24.19.0** and npm **11.17.0**, matching the current pins. Recheck web/.nvmrc and web/package.json after switching branches.
- A desktop browser with WebGL2 support.
- Docker Desktop with Linux containers/WSL 2 on Windows only if using the optional container workflow.

## Clone and install

Run these commands in a terminal. If you already have a checkout, preserve uncommitted work before switching branches.

~~~sh
git clone https://github.com/Team-Meshworks/gam300.git
cd gam300
git switch dev
git lfs install
git lfs pull
cd web
node --version
npm --version
npm ci
~~~

Git LFS fetches the model bytes; a small text pointer file is not a usable GLB. npm ci installs the committed dependency lockfile. Playwright is already a development dependency; no separate external installation is needed.

## Run the editor

From web/:

~~~sh
npm run dev
~~~

Open [http://localhost:5173/](http://localhost:5173/). Leave this terminal running. The **Open sample project** control is development-only and is intentionally absent from production builds.

Follow [Using VThere](/en/user-guide) for a short walkthrough. The current prototype reports unsaved work; do not rely on refreshing or closing the page to preserve edits.

## Useful commands

Run from web/:

| Command | Purpose |
| --- | --- |
| npm run typecheck | Check TypeScript |
| npm run lint | Lint with zero warnings allowed |
| npm run format:check | Check formatting without changing files |
| npm run test:unit | Run Vitest domain/editor tests |
| npm run build | Typecheck and build the editor |
| npm run preview | Serve the built editor locally |
| npx playwright install chromium | Install the locked browser test runtime once |
| npm run test:browser | Run authoring checks with the dev server running |

See [Testing](/en/testing) for selecting relevant checks and recording results.

## Optional container workflow

From the repository root, with Docker running:

~~~sh
docker compose up --build --wait
~~~

Open [http://localhost:8081/](http://localhost:8081/). Stop this local application from the same directory with:

~~~sh
docker compose down
~~~

These commands are for your local application checkout. On the shared VM use the scoped [deployment runbook](/en/deployment).

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Node/Vite native-binding or syntax errors | Confirm Node/npm versions, then rerun npm ci from web/. Do not update dependencies to work around a mismatched runtime. |
| Missing or unreadable models | Run git lfs pull and check repository/LFS access. |
| PowerShell blocks npm.ps1 | Use npm.cmd with the same arguments, or follow your machine's approved execution policy. |
| Port 5173 already in use | Read Vite's printed URL; stop the old server or pass the actual URL to the browser check. |
| WebGL unavailable | Enable supported browser graphics; record the machine/browser and use the displayed fallback. |
| Demo asks for a login | VM application access is separate from GitHub and Wiki.js accounts. Ask the team administrator. |

## Source of truth

[Package scripts and versions](https://github.com/Team-Meshworks/gam300/blob/dev/web/package.json), [Node pin](https://github.com/Team-Meshworks/gam300/blob/dev/web/.nvmrc) and the [tracked runbook](https://github.com/Team-Meshworks/gam300/blob/dev/docs/deployment.md) take precedence over old copied setup notes.

[Back to handbook](/en/home)

_Last reviewed against dev e5591d0 on 23 September 2026. Commands were checked against configuration for this wiki setup; the application suite was not rerun for these documentation changes._
