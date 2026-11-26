# Spatia

Spatia is a browser-based editor for building interactive 3D spaces. Arrange rooms and objects, add **WHEN → DO** rules without writing code, and preview the space from a visitor's point of view.

## What you can do

- Build scenes from an asset catalogue and move, rotate, or scale objects in the viewport.
- Add hotspots, media, and interaction rules to make scenes respond to visitors.
- Undo and redo edits, save projects to the server, and recover recent edits from a browser draft.
- Preview a space in the editor or publish a supported project revision to a separate visitor app for selected signed-in viewers.

Spatia is under active development. Authoring requires a provisioned account and edit access to a project. Projects can contain content the editor preserves but the player does not yet support; preview and publication check for unsupported features.

## Quick start

You’ll need Git with Git LFS, Docker with Linux container support and Compose, and a browser with WebGL 2.

From the repository root, run `bash run.sh` on macOS or Linux, or `run.bat` on Windows. Open [localhost:8081](http://localhost:8081). To stop the default local stack, run `docker compose --project-name spatia-local down`.

This launcher starts only the web service. To sign in, create or edit server projects, or test publication, follow the [local API and PostgreSQL setup](docs/deployment.md#local-api-and-postgresql-integration) and the [server guide](apps/server/README.md).

## Development

The web apps use React, TypeScript, Vite, and Three.js. The API uses ASP.NET Core and PostgreSQL. The two runtimes validate a shared [project format](docs/project-format.md).

Use the Node and npm versions pinned in [the web package](apps/web/package.json). For Vite hot reload:

```sh
cd apps/web
npm ci
npm run dev
```

For web checks, run `npm run lint`, `npm run format:check`, `npm run test:unit`, and `npm run build` from `apps/web`. Browser tests use the repository's [Chrome verification setup](docs/deployment.md#local-development). See the [server guide](apps/server/README.md#toolchain-and-checks) for the pinned .NET SDK and server checks.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`apps/web/editor`](apps/web/editor) | Authoring UI, viewport, and project editing |
| [`apps/web/visitor`](apps/web/visitor) | Visitor application |
| [`apps/web/shared`](apps/web/shared) | Shared player, project model, and asset catalogue |
| [`apps/server`](apps/server) | API, account and project services, and server tests |
| [`assets`](assets) | Asset catalogue, delivery files, and provenance |
| [`docs`](docs) | Architecture and developer documentation |

## Contributing

Branch from `dev`, keep changes focused, and include relevant verification in pull requests. See the [architecture notes](docs/architecture.md) before changing module boundaries and the [asset guide](assets/README.md) before adding assets.
