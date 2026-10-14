# Server persistence foundations

This .NET 10 class library contains a bounded draft-save reader and the Identity/
PostgreSQL account persistence foundation. It has no running API host, routes,
session authentication, project validator or project store. A parsed envelope remains
untrusted until the shared project validator and current authorization checks accept it.

`SaveEnvelopeReader.ReadAsync(HttpRequest, Guid, CancellationToken)` returns a
`SaveEnvelopeReadResult`. It contains either `Envelope` (a `ParsedSaveEnvelope`) or
`Error` (a `SaveEnvelopeError`); the caller supplies the parsed route project ID.
Successful parsing retains `UnvalidatedDocumentJson`, including unknown
and duplicate nested document properties, for later domain validation. Root
`projectId` is required exactly once and must match the route ID. A document containing
only that ID can parse successfully; parsing does not establish a valid project.

The request envelope contains exactly `expectedRevision`, `clientMutationId` and
`document`. Revisions use integer JSON tokens in `0..9007199254740991`; mutation and
document IDs use UUID D form. Input must be UTF-8 `application/json`, with omitted or
UTF-8 charset and absent or identity content encoding. The reader rejects a UTF-8 BOM.
It reads at most 6 MiB plus one overflow-detection byte, independently of declared
Content-Length, and accepts a document of at most 5 MiB in its original UTF-8 JSON
representation. Internal whitespace counts. Document nesting depth is at most 32,
with an additional level for the envelope. These are reader limits; a future API
must also configure and verify its actual HTTP host/proxy limits.

Expected failures return fixed status/code/path/message data without authored
content. Cancellation and stream I/O failures propagate, and the reader leaves the
request body open. It does not emit an HTTP response or grant access.

## Toolchain and checks

Install .NET SDK **10.0.401**. `global.json` disables SDK roll-forward and selects
Microsoft.Testing.Platform. The test project uses TUnit **1.68.17**. The included NuGet
lockfiles fix its dependency graph. Restore normally retains NuGet vulnerability
checks. Changes to package versions require deliberately regenerating and reviewing
the lockfiles.

Run the canonical check block below from `apps/server/` so the scoped SDK pin applies.

The build checks both projects with nullable analysis, style enforcement and warnings
as errors. The minimum-test option is passed to the test module after `--`, so skipped
tests do not satisfy it. The test runner uses local named pipes; Codex's restricted
Windows sandbox denied those pipes before executing tests and before loading the
formatter workspace. The formatter and test commands were verified through scoped
permission to run outside that sandbox. A normal developer shell does not inherit
that sandbox restriction.

Verified on 9 October 2026 against the working tree: locked restore passed; Release
build passed with zero warnings/errors; both formatting checks passed; **74 tests
executed and passed, zero skipped**. Tests cover strict envelope fields, revision/UUID
boundaries, root binding, preserved unvalidated JSON, malformed Unicode and JSON,
media/encoding, byte/depth limits, misleading lengths, short nonseekable reads,
cancellation, I/O failures and request-body lifetime. Generated reports are ignored
by Git:

- `test-results/Spatia.Server.Tests_net10.0_x64.trx`
- `test-results/Spatia.Server.Tests-windows-net10.0-report.html`

The first executed run found malformed Unicode property-name comparisons escaping
as exceptions; the reader now handles that comparison failure and the regression
cases pass. Earlier sandbox runner attempts executed zero tests and were failures.
The initial build's added IDE0005 warning override required unrelated XML-document
generation; that override was removed while retaining the scoped style rules.

The historical reader run above did not exercise PostgreSQL or Identity. The account
foundation checks below are a separate slice; sessions/CSRF, complete domain validation,
hosted limits, API restart and fresh-browser persistence remain integration work.

## Identity and organization persistence foundation

`Accounts.ApplicationUser` inherits `IdentityUser<Guid>` and initially sets `IsActive`
and `MustChangePassword` true. The inherited password hash, normalized username,
security/concurrency stamps and lockout fields remain owned by ASP.NET Core Identity.
Inherited user/role claim IDs remain integers. `ApplicationRoles` provides stable
Administrator, Educator and Creator names/UUIDs, seeded through the migration.

`Persistence.ApplicationDbContext` uses Npgsql and the default Identity v1 schema.
`AddSpatiaAccounts(IServiceCollection, string)` registers that context and standard
Identity user/role stores. It returns `IdentityBuilder` for subsequent configuration;
this slice keeps the framework's manager/password policies and does not create a
session, provision an account or grant HTTP access.

The database permits at most one global role and at most one organization membership
per user. Later provisioning and principal-validation slices will enforce required
roles and non-administrator organization memberships.
`organization_memberships` requires an existing organization and the same user/role
pair in Identity's assignments, and permits only Educator or Creator membership.
Referenced organizations and role assignments cannot be deleted while a membership
uses them. Organization IDs are UUIDs and names are required with a 256-character
limit. No projects or lifecycle endpoints exist yet.

Package pins are Identity EF/EF Core Design **10.0.12** and Npgsql EF **10.0.3**;
Microsoft EF dependencies resolve to **10.0.12** in the lockfiles. The repository-local
`dotnet-ef` manifest pins **10.0.12**. Restore the tool with `dotnet tool restore`.
`ApplicationDbContextFactory` requires `ConnectionStrings__Spatia`; it fails when the
variable is absent. Do not put real connection strings in source or command arguments.
The TUnit executable supplies the design-time startup runtime, avoiding an extra host.

The canonical check block below restores the tool and builds the startup executable
before running the three migration-tool checks with private configuration still set.

Review generated migrations and SQL before applying them. There is no startup-time
migration or public-schema database reset. Application configuration must supply an
explicit database target when a host is added.

## Disposable PostgreSQL checks

The database tests require `SPATIA_TEST_DATABASE_CONNECTION` and fail explicitly if
it is missing. The fixture accepts only a literal loopback host (`127.0.0.1` or `::1`)
and database **spatia_scrum45_test**, then confirms `current_database()` before it
creates a random `spatia_scrum45_<uuid>` schema. Each fixture uses that schema as its
search path, applies the actual production migration, and removes only the exact
schema it created. It never uses `EnsureCreated`, resets `public`, or clears other
data. Test connections disable pooling so reopened-scope durability uses new
connections. Duplicate-insert races use separate contexts.

Use a dedicated disposable PostgreSQL instance. The local SCRUM-45 setup uses the
official **postgres:18.6** image, a unique container with `spatia.task=SCRUM-45` and
`spatia.disposable=true` labels, an automatically assigned port bound only to
`127.0.0.1`, and fresh image-owned anonymous storage. It creates only the test database
and a synthetic test user. Container credentials are random and passed via process
environment. A private connection file and non-secret container identity are saved
under ignored `.artifacts/`; these are local setup evidence, not tracked configuration.
Keep the exact owned container for controlled restart verification, then remove only
that recorded container/storage when authorized. Never point these tests at Wiki.js,
partner, pilot or shared databases.

For a fresh checkout with Docker running and its CLI on PATH, configure the test
process privately. These PowerShell commands create a unique container with no bind
mount or reused volume; keep its recorded ID for scoped cleanup:

```powershell
$taskContainerName = 'spatia-scrum45-postgres-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$env:POSTGRES_PASSWORD = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
try {
  $taskContainerId = docker run --detach --name $taskContainerName --label spatia.task=SCRUM-45 --label spatia.disposable=true --publish 127.0.0.1::5432 --env POSTGRES_DB=spatia_scrum45_test --env POSTGRES_USER=spatia_test --env POSTGRES_PASSWORD postgres:18.6
  if ($LASTEXITCODE -ne 0) { throw 'Disposable container creation failed.' }
  $taskPort = docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' $taskContainerId
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read the owned container port.' }
  $env:SPATIA_TEST_DATABASE_CONNECTION = 'Host=127.0.0.1;Port=' + $taskPort.Trim() + ';Database=spatia_scrum45_test;Username=spatia_test;Password=' + $env:POSTGRES_PASSWORD
} finally {
  Remove-Item Env:/POSTGRES_PASSWORD -ErrorAction SilentlyContinue
}
$taskReady = $false
for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
  docker exec $taskContainerId pg_isready -h 127.0.0.1 -p 5432 -U spatia_test -d spatia_scrum45_test 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $taskReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $taskReady) { throw 'Owned disposable PostgreSQL did not become ready.' }
$env:ConnectionStrings__Spatia = $env:SPATIA_TEST_DATABASE_CONNECTION
$taskContainerId
$taskContainerName
$taskPort
```

Run the canonical check block below from `apps/server/` with this private configuration.
It restores packages and tooling, builds, then checks migrations and tests before removing both
connection environment variables. Preserve or remove only the recorded owned container
and its new anonymous volume; never clean containers or volumes globally.

For the existing verified SCRUM-45 setup, use this alternative configuration step:

```powershell
$env:SPATIA_TEST_DATABASE_CONNECTION = [System.IO.File]::ReadAllText((Join-Path (Get-Location) '.artifacts/scrum45-postgres-connection.txt'))
$env:ConnectionStrings__Spatia = $env:SPATIA_TEST_DATABASE_CONNECTION
```

Run the required checks:

```powershell
dotnet restore tests/Spatia.Server.Tests.csproj --locked-mode
dotnet tool restore
dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore
dotnet format Spatia.Server/Spatia.Server.csproj --verify-no-changes --no-restore
dotnet format tests/Spatia.Server.Tests.csproj --verify-no-changes --no-restore
New-Item -ItemType Directory -Path .artifacts -Force | Out-Null
dotnet ef migrations list --no-connect --project Spatia.Server --startup-project tests --configuration Release --no-build
dotnet ef migrations has-pending-model-changes --project Spatia.Server --startup-project tests --configuration Release --no-build
dotnet ef migrations script --idempotent --project Spatia.Server --startup-project tests --configuration Release --no-build --output .artifacts/identity-migration.sql
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results -- --report-trx --minimum-expected-tests 1
Remove-Item Env:/SPATIA_TEST_DATABASE_CONNECTION
Remove-Item Env:/ConnectionStrings__Spatia
```

The added tests cover design/DI model agreement, guarded database targets, migration
and role seeds, standard store resolution, normalized username races, password hashing,
account flags/stamps/UTC lockout durability, single-role/organization constraints,
invalid memberships, restricted deletion and transactional rollback without orphan
users/assignments. These are schema/manager checks, not HTTP authorization acceptance.
They do not prove first-password restrictions, cookie/CSRF/logout/lockout behavior,
administrator-only provisioning, account lifecycle or project access rules.

Verified on 14 October 2026 against this working tree after migration/SQL review:
locked restore, Release build (zero warnings/errors), both format checks, local tool
restore, no-connect migration listing, pending-model check and idempotent SQL generation
passed. **91 tests executed and passed, zero skipped**: 74 unchanged reader cases,
11 real PostgreSQL persistence cases and 6 model/guard cases. The final suite took
6.850 seconds and wrote the TRX/HTML paths listed above. A post-run database catalog
check confirmed zero `spatia_scrum45_*` fixture schemas remained. Reapplying the
migration preserved an existing synthetic account and the three role seeds.

The first new-source build found nullable assertion-return handling in the tests;
the shared test helper now handles it. The first executed suite passed 90/91 cases;
the restricted-deletion assertion was corrected to PostgreSQL `restrict_violation`
(`23001`), then the final suite passed. No production behavior was weakened.
The disposable container remains available for later authorized verification.
