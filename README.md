# Spatia

Spatia is a browser-based editor for building interactive 3D spaces. Arrange rooms and objects, add **WHEN → DO** rules without writing code, and preview the space from a visitor's point of view.

## The problem

Students without programming or 3D software experience cannot create interactive spatial experiences using existing tools. Spatia aims to give them a way to build those experiences in a browser, using a visual editor and interactions that do not require code.

## Who it's for

- **Creators**, including students, build and edit spaces. For example, a student can arrange objects for an exhibition and add a hotspot for visitors to select.
- **Educators** assign projects to students and review their submissions.
- **Administrators** manage organisations, accounts, and access.
- **Viewers** explore published spaces that have been made available to them.

## What you can do

- Build scenes from an asset catalogue and move, rotate, or scale objects in the viewport.
- Add hotspots, media, and interaction rules to make scenes respond to visitors.
- Undo and redo edits, save projects to the server, and recover recent edits from a browser draft.
- Preview a space in the editor or publish a supported project revision to a separate visitor app for selected signed-in viewers.

## Using Spatia

1. Sign in with a provisioned creator account. Create a project or open one assigned to you.
2. Choose a space and arrange objects from the asset catalogue. Add hotspots, media, and **WHEN → DO** rules for the interactions you want.
3. Check the save status and use **Preview** to try the space as a visitor. Exit preview to keep editing.
4. When the saved revision is ready, publish it and select the accounts allowed to view it. Some assignments require educator approval first. Selected viewers must be active members of the same organisation and have changed their temporary passwords.
5. Share the visitor link with those viewers. They sign in to explore the published space.

## Known limitations

- Spatia is under active development. Authoring requires a provisioned account and permission to edit a project.
- Some project content can be preserved by the editor but is not yet supported by the player. Preview and publication check for unsupported features.
- Launching the app and viewing a published space require a connection. A browser draft can help recover recent edits, but it is not an offline visitor mode.
- Distribution rights for some development assets are still unconfirmed; see the [asset guide](assets/README.md) before distributing them.

## Quick start

You’ll need Git with Git LFS, Docker with Linux container support and Compose, and a browser with WebGL 2.

From the repository root, run `bash run.sh` on macOS or Linux, or `run.bat` on Windows. Open [localhost:8081](http://localhost:8081). To stop the default local stack, run `docker compose --project-name spatia-local down`.

This launcher starts only the web service. Sign-in, server projects, and publishing need the full stack below.

### Run the full stack locally

From the repository root, download the delivery assets and create an ignored `.env` file. Replace the two password placeholders with different, randomly generated hexadecimal strings of at least 32 characters. Keep the values private and stable when restarting an existing database.

```sh
git lfs pull --include="assets/delivery/**" --exclude=""
```

```dotenv
SPATIA_DATABASE_PASSWORD=<database-password>
SPATIA_API_PASSWORD=<different-api-password>
PUBLICATION_ORIGIN=https://localhost:8444
```

The publication origin above enables links for this computer. It must be an HTTPS origin without a path; a different device needs its own reachable, trusted origin and server configuration.

Start Docker with its Linux engine running. If the web-only stack above is running, stop it first with `docker compose --project-name spatia-local down`; both stacks use port 8081 by default. Then validate and start the full stack:

```sh
docker compose -f compose.yaml -f compose.server.yaml -p spatia-server config --quiet
docker compose -f compose.yaml -f compose.server.yaml -p spatia-server up -d --build --wait
```

Open `https://localhost:8444`. The local gateway uses a certificate issued by its own CA, so a browser will not trust it by default. Export the CA with the command below and configure your local browser or operating system to trust it for development before opening the site:

```sh
docker compose -f compose.yaml -f compose.server.yaml -p spatia-server cp gateway:/data/caddy/pki/authorities/local/root.crt ./spatia-local-ca.crt
```

A fresh database has no accounts. After the stack starts, use PowerShell 7.4 or later to create the first administrator. Run this from the repository root; the password is prompted for and passed through standard input.

```powershell
$bootstrapUser = Read-Host 'New administrator username'
$securePassword = Read-Host 'Temporary password (12-128 characters)' -AsSecureString
try {
  $password = ConvertFrom-SecureString $securePassword -AsPlainText
  $payload = @{ userName = $bootstrapUser; initialPassword = $password } | ConvertTo-Json -Compress
  $payload | docker compose -f compose.yaml -f compose.server.yaml -p spatia-server exec -T api dotnet Spatia.Server.dll bootstrap-admin
  if ($LASTEXITCODE -ne 0) { throw "Bootstrap failed with exit code $LASTEXITCODE" }
} finally {
  $password = $null
  $payload = $null
  $securePassword.Dispose()
}
```

Sign in as the administrator and change the temporary password when prompted. Create an organisation and the creator and educator accounts needed for your test, including accounts for the people who will view a publication. The [server guide](apps/server/README.md#private-bootstrap-and-administrator-operations-part-4) describes the bootstrap operation and its exit codes; the [deployment guide](docs/deployment.md#local-api-and-postgresql-integration) has more local configuration details.

To stop the full stack while keeping its database and keys:

```sh
docker compose -f compose.yaml -f compose.server.yaml -p spatia-server down
```

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
