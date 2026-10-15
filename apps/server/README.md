# Server reader, accounts and security

This .NET 10 ASP.NET Core host contains a bounded draft-save reader, the Identity/
PostgreSQL account persistence foundation, request-security boundary and private
administrator provisioning/reset operations. Production routes are the CSRF bootstrap
and three administrator POSTs described below. Login, logout, first-password completion
and project handlers remain later work. A parsed envelope remains
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
foundation and request-boundary checks below are separate slices. Complete domain
validation, real account workflows and fresh-browser project persistence remain work.

## Identity and organization persistence foundation

`Accounts.ApplicationUser` inherits `IdentityUser<Guid>` and initially sets `IsActive`
and `MustChangePassword` true. The inherited password hash, normalized username,
security/concurrency stamps and lockout fields remain owned by ASP.NET Core Identity.
Inherited user/role claim IDs remain integers. `ApplicationRoles` provides stable
Administrator, Educator and Creator names/UUIDs, seeded through the migration.

`Persistence.ApplicationDbContext` uses Npgsql and the default Identity v1 schema.
`AddSpatiaAccounts(IServiceCollection, string)` registers that context and standard
Identity user/role stores. It returns `IdentityBuilder` for subsequent configuration;
this registration keeps framework manager/password defaults. The request-security
composition below adds its policies. The administration service uses the same context and stores.

The database permits at most one global role and at most one organization membership
per user. Current-principal validation requires one fixed role and the matching active
organization membership for non-administrators. Administrator provisioning establishes
these records atomically.
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
The documented EF commands use the TUnit executable as their design-time startup.
The running API host is `Spatia.Server`.

The canonical check block below restores the tool and builds the startup executable
before running the three migration-tool checks with private configuration still set.

Review generated migrations and SQL before applying them. There is no startup-time
migration or public-schema database reset. Current startup configuration requires an
explicit database target.

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

For the retained SCRUM-45 container, revalidate its recorded identity, labels and owned
storage before starting it. Its published loopback port is assigned dynamically: read
the actual port after every restart and update the private connection file and non-
secret ownership metadata before loading them. The last observed port was 58798 and
may change. Then use this alternative configuration step:

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
users/assignments. These Part 2 schema/manager checks did not establish HTTP authorization behavior.
Part 3 adds the request-boundary checks below, and Part 4 adds actual administration.
Real login/password-change/logout workflows, account lifecycle and project access remain later work.

Part 2 was verified on 14 October 2026 before the request-boundary additions:
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
The owned disposable container and configuration are retained for later verification.

## API request-security foundation

`Hosting.SpatiaApplication.Build(WebApplicationBuilder)` composes the real Kestrel
host. `Program` builds and runs it; no automatic schema migration or account
provisioning happens at startup. `GET /api/auth/csrf` returns `{requestToken}` and an
ASP.NET antiforgery cookie. All browser JSON writes require a single `X-CSRF-TOKEN`
header; bootstrap again after the authenticated principal changes. No login, logout,
first-password completion or project endpoint is shipped yet. The three administration
routes below extend the original Part 3 boundary.

Startup requires `ConnectionStrings__Spatia`, `DataProtection__KeyDirectory` (an
absolute existing directory) and explicit non-wildcard `AllowedHosts`. Operators
must protect the database configuration and Data Protection directory with appropriate
filesystem/account permissions. This slice does not encrypt persisted key XML at rest;
operator account/filesystem protection is required. Keys persist with application isolation
`Spatia:<environment name>`. Provision an HTTPS certificate through standard Kestrel
configuration or a verified developer certificate. The host rejects HTTP with 400
rather than redirecting it. A non-secret development invocation, after privately
setting the database and key directory and configuring HTTPS, is:

```powershell
$env:AllowedHosts = 'localhost;127.0.0.1'
$env:ASPNETCORE_URLS = 'https://127.0.0.1:7443'
dotnet run --project Spatia.Server -c Release --no-build
```

`TrustedProxies__0`, `TrustedProxies__1`, and so on may identify explicit trusted
proxy IPs. With no entries, forwarded headers are ignored. With entries, the host
accepts one forwarded For/Proto hop from a known proxy and ignores Forwarded-Host.
Automatic forwarded-header configuration is rejected. Wildcard host values,
including unspecified-address aliases, are rejected at startup. The current host's
request-body ceiling is **16 KiB**. Kestrel counts HTTP/1 chunk framing within that
ceiling. This test writer emits one four-hex-digit chunk with no trailers, adding
13 framing bytes: its tested decoded boundary is 16,371 bytes, versus 16,384 bytes
with Content-Length. Chunk framing overhead is not universally 13 bytes. The save reader's 5/6 MiB budgets do not
establish a hosted project-save limit because no project endpoint exists yet.

The Identity application cookie is Secure, HttpOnly, SameSite=Lax and nonpersistent.
It has no sliding expiration. Its protected absolute cutoff remains eight hours from
sign-in across framework security-stamp refreshes, and the exact cutoff is expired.
Every cookie request rechecks the current database user, security stamp, fixed role
ID/name, membership and active organization. Cookie role/org claims cannot grant
permissions. `CurrentAccount` is the scoped HTTP feature containing current non-secret
account metadata. Invalid account state rejects/clears the cookie; database failure
returns 503 while preserving it. Forced-password state has no ordinary access, and
`CurrentAccount` policy permits it only on the intended auth path/verb allowlist.

`SecurityPolicies.FullAccount` is the default/fallback policy; `CurrentAccount` and
`Administrator` are explicit policies; administration uses `Administrator`. `AuthenticationRateLimit`
is 60 requests/minute per trusted effective IP; `AccountWriteRateLimit` is 20/minute
per validated current user, with IP fallback. The endpoint concurrency limit after
authentication is 64, with no queue. It does not bound the current-principal database
checks that run before authorization. Rate rejections return 429 plus Retry-After. Protected anonymous and
forbidden requests return 401/403 problem JSON with no sign-in redirects. API failures
include a fixed code and trace ID; transport/host-filter failures may be fixed empty
responses. Response logs contain method, route template, status, duration and trace
ID, with framework diagnostics suppressed even under conflicting category rules.
Passwords, cookies, tokens, connection strings, bodies and raw exception text are
excluded. Identity composition configures 12–128-character passwords and five-failure,
five-minute lockout options; actual login/lockout handlers are later work.

The new tests use built-in Kestrel, a short-lived synthetic test certificate and a certificate-
pinned HttpClient, real PostgreSQL owned schemas, a controlled clock and owned temporary
key directories. Synthetic sign-in/probe/write routes are appended solely by the test assembly;
they do not ship in the API. On Windows, the certificate is exported/reloaded in memory
with default temporary provider key storage for Schannel and disposed with its fixture;
no PFX file, certificate-store entry or global trust change is created. Test setup failures and cleanup are scoped to the exact
created schema and key directory. A browser case uses the existing apps/web Playwright
**1.63.0** package and Chromium to check real same-origin bootstrap, cookie visibility,
principal refresh and JSON-write rejection/acceptance. Its isolated browser context
allows the synthetic certificate only for this loopback test flow and blocks other
origins; it does not install a certificate or change global browser trust.

Run the canonical checks above from `apps/server/`, with the disposable PostgreSQL
instance running. The browser case also requires the pinned web dependencies and
Chromium installed. A fresh checkout uses `apps/web/node_modules/playwright/index.mjs`;
a managed checkout may set `PLAYWRIGHT_MODULE` to that same existing package in its
primary checkout. `PLAYWRIGHT_BROWSERS_PATH` can select the existing Chromium cache
when sandbox AppData differs. No additional server test-host/time-provider/browser
package is required. Database configuration is removed from the Node child's environment.

Part 3 was verified on 14 October 2026 against the working tree based on `3e63b057`
after source review. Locked restore, Release build (zero warnings/errors), both format
checks, pinned EF tool restore, no-connect migration listing, pending-model check
(no model changes) and idempotent SQL generation passed. **163 tests executed and
passed, zero skipped**, in **24.149 seconds**: the 91 baseline cases plus 13 current-
principal, 16 cookie/CSRF/password/browser and 43 host-boundary cases. The final TRX
and HTML use the `test-results/` paths recorded above. The passed browser flow used
**Node 24.19.0**, **Playwright 1.63.0** and actual **Chromium 153.0.8010.12**;
non-secret runtime metadata is in `.artifacts/scrum45-browser-version.txt`.

The first formatting checks found final CRLF markers and initializer whitespace in
new files; scoped nonsemantic formatting fixed them. The first full run executed
163 cases with 125 passed and 38 failed: the synthetic creation-time certificate was
not usable by Windows Schannel, and the browser path assumed the wrong MTP working
directory. In-memory certificate export/reload and resolving the script from the
test assembly's known project layout fixed the fixture; one focused HTTPS case passed.
The second full run passed 162/163 in 25.034 seconds. Its remaining assertion treated
HTTP/1 chunk framing as free space; the pinned Kestrel budget includes it. The corrected
four declared/chunked boundary cases passed, then the final 163-case suite passed.
Production behavior was not weakened to satisfy these fixture corrections.

The historical Part 3 tests prove current request boundaries, JSON CSRF and retained-key application-
instance reconstruction. That run did not establish real administrator provisioning,
password login/logout workflows, project access, full frontend usability or database-
container restart acceptance. Persisted key XML remains unencrypted at rest and the
64-request concurrency limit begins after authentication; the operator protection and
preauthorization database-check limitations above remain.
Final cleanup verification found zero owned PostgreSQL fixture schemas, zero public
tables and no remaining fixture key directories. Root revalidated and stopped only
the recorded disposable container; it is exited, with its volume and protected local
configuration retained. No further application tests were run for documentation-only
corrections.

## Private bootstrap and administrator operations (Part 4)

`dotnet Spatia.Server/bin/Release/net10.0/Spatia.Server.dll bootstrap-admin` is the
private operator entry point. It builds the actual application services without
starting a listener. Supply exactly UTF-8 JSON `{userName,initialPassword}` through
redirected standard input, at most 16,384 bytes. Interactive input, additional command
arguments, unknown/duplicate/wrong-case JSON fields and incomplete input are rejected.
Passwords belong neither in arguments nor environment variables nor JSON files.
The database connection remains private process configuration.

The command takes a PostgreSQL role-assignment table lock and creates a new global
Administrator plus its standard role in one transaction. Any existing fixed-ID
administrator assignment causes refusal, including an inactive or forced-change
administrator. It never promotes, resets or re-enables an existing account. Exit codes
are **0 created**, **3 existing administrator**, **2 invalid input/username collision**
and **1 failure/cancellation or uncertain completion**. Output contains fixed messages.
There is no automatic administrator creation during ordinary startup.

After the canonical build above, configure the intended, reviewed/migrated application
database and protected key directory privately. Bootstrap does not apply migrations.
From `apps/server/` in PowerShell 7.4+, use a password prompt and a redirected child
stream, without saving the credential payload:

```powershell
$env:ConnectionStrings__Spatia = Read-Host 'Application connection string' -MaskInput
$env:DataProtection__KeyDirectory = Read-Host 'Existing protected absolute key directory'
$env:AllowedHosts = 'localhost'
$bootstrapUserName = Read-Host 'New administrator username'
$bootstrapSecurePassword = Read-Host 'Temporary password (12-128 unchanged characters)' -AsSecureString
$bootstrapProcess = $null
try {
  $bootstrapPassword = ConvertFrom-SecureString $bootstrapSecurePassword -AsPlainText
  $bootstrapJson = @{ userName = $bootstrapUserName; initialPassword = $bootstrapPassword } | ConvertTo-Json -Compress
  $bootstrapStart = [System.Diagnostics.ProcessStartInfo]::new('dotnet')
  $bootstrapStart.UseShellExecute = $false
  $bootstrapStart.CreateNoWindow = $true
  $bootstrapStart.RedirectStandardInput = $true
  $bootstrapStart.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
  $bootstrapStart.ArgumentList.Add((Join-Path (Get-Location) 'Spatia.Server/bin/Release/net10.0/Spatia.Server.dll'))
  $bootstrapStart.ArgumentList.Add('bootstrap-admin')
  $bootstrapProcess = [System.Diagnostics.Process]::Start($bootstrapStart)
  $bootstrapProcess.StandardInput.Write($bootstrapJson)
  $bootstrapProcess.StandardInput.Close()
  if (-not $bootstrapProcess.WaitForExit(30000)) {
    $bootstrapProcess.Kill($true)
    $bootstrapProcess.WaitForExit()
    throw 'Bootstrap outcome is uncertain; inspect private database state before retrying.'
  }
  'Bootstrap exit code: ' + $bootstrapProcess.ExitCode
} finally {
  $bootstrapPassword = $null
  $bootstrapJson = $null
  $bootstrapSecurePassword.Dispose()
  if ($null -ne $bootstrapProcess) {
    if (-not $bootstrapProcess.HasExited) {
      $bootstrapProcess.Kill($true)
      $bootstrapProcess.WaitForExit()
    }
    $bootstrapProcess.Dispose()
  }
  Remove-Item Env:/ConnectionStrings__Spatia -ErrorAction SilentlyContinue
  Remove-Item Env:/DataProtection__KeyDirectory -ErrorAction SilentlyContinue
  Remove-Item Env:/AllowedHosts -ErrorAction SilentlyContinue
}
```

The administrator initially requires a password change. The real sign-in and
first-password completion routes are a later slice, so this part's tests mint
sessions only through routes in the test assembly. A normal operator cannot yet
complete the full browser account lifecycle. Retained Data Protection XML is not
encrypted at rest: operator account and filesystem protection remain required.

All three writes require the current, active, unforced Administrator, the existing
CSRF header and the `AccountWrite` rate policy:

| Route | Required JSON | Result |
| --- | --- | --- |
| `POST /api/admin/organizations` | `name` | 201 `{id,name,isActive}` |
| `POST /api/admin/users` | `userName,initialPassword,role,orgId` | 201 `{userId,userName,role,orgId,isActive,mustChangePassword}` |
| `POST /api/admin/users/{id}/password` | `newTemporaryPassword` | 204 |

Username and organization name are preserved unchanged, 1-256 characters and not
whitespace-only; username also follows standard Identity allowed-character rules.
Organization names containing NUL are rejected. Passwords are preserved unchanged,
12-128 characters, without composition rules. Only exact fixed role names are
accepted. `orgId` is a required key even when null: Administrators require null;
Educators/Creators require an active organization. Unknown, duplicate, wrong-case,
wrong-type and missing JSON properties are rejected. Fixed problems map invalid input
to 400, normalized username collision/optimistic concurrency to 409, unavailable
organization to 422 and an authorized missing reset target to 404. Passwords, reset
tokens, hashes, stamps and raw Identity descriptions are absent from responses/logs.

Provisioning commits account, role and required membership together. Reset generates
and consumes a standard Data Protection reset token inside the server, setting the
forced-change flag before the standard manager update, inside one outer transaction.
It rotates the security stamp and preserves account activation, memberships, role and
lockout state. It neither retries stale credentials nor automatically unlocks an
account. Existing target-account cookies, including the administrator's own cookie after self-reset,
fail the next current-stamp check with 401. The reset handler does not sign in or
refresh a session; a normal five-minute framework renewal may still emit an old-stamp
actor cookie with the original absolute cutoff. On self-reset, that renewed cookie
has the old stamp and fails next time; an administrator resetting another account
keeps its own actor session usable.
A lost response can mean an uncertain committed result; inspect state and use an
explicit administrator reset rather than blindly replaying credential operations.

Part 4 verification uses the same guarded database and HTTPS
fixtures, real redirected bootstrap processes, deterministic added/modified-user
save barriers and a test-only transaction-commit failure/cancellation interceptor.
The browser check now calls the real organization/account/reset routes and verifies
revocation of the target's old cookie; its sign-in remains a test-only helper.
The nonredirected-console refusal branch is source-reviewed only in the headless
harness. No full login/logout/first-password, product UI, project or database restart
acceptance is claimed. The actual execution evidence follows.
The initial locked restore and pinned tool restore passed. The first Release build
found five test-only compile errors: the captured-log API returns a joined string,
so assertions were corrected to use string containment. Release build then passed
with zero warnings/errors. Production formatting passed; test formatting initially
reported initializer whitespace and final line endings. Scoped nonsemantic formatting
corrected those differences, and test-format verification plus Release rebuild passed.
The no-connect migration list, pending-model check (no changes) and idempotent SQL
generation passed. No new packages, schema migration or production behavior change
was needed for verification.

The first full run executed **251 cases: 250 passed, one failed, zero skipped**, exit
2, in **93.214 seconds**. Its sole failure was the bootstrap concurrency observer's
application-name filter: PostgreSQL truncates its 66-byte tag to 63 bytes. A shorter
61-byte tag retaining the unique schema fixed the observer. Two malformed CLI fixtures
also received valid baseline usernames so an independent username failure could not
mask JSON-shape rejection. The corrected concurrency case passed **1/1 in 6.418 seconds**,
and the strict-JSON cases passed **10/10 in 8.354 seconds** after format/build checks.
Initial and focused TRX/HTML reports are retained under `test-results/part4-initial/`,
`test-results/part4-bootstrap-lock/` and `test-results/part4-bootstrap-json/`.
The final full run passed **251 executed / 251 passed / zero failed / zero skipped**,
exit **0**, in **77.283 seconds** (module 76.785 seconds). The final TRX confirms
74 unchanged reader, 11 persistence, 6 model/guard, 43 host, 13 principal, 16 security,
68 administration endpoint and 20 bootstrap cases. Reports use the canonical
`test-results/` TRX/HTML paths above. The actual browser run used **Node 24.19.0**,
**Playwright 1.63.0** and **Chromium 153.0.8010.12**, recording both administration
and CSRF pass markers in `.artifacts/scrum45-browser-version.txt`. No production
behavior changed to resolve the observer or malformed-input fixture corrections.

The retained disposable container was identity/label/volume/binding checked before
restart, with its dynamic loopback port refreshed privately to **58798** for this run.
The initial PowerShell connection-update guard failed before any private file write;
using the actual `DbConnectionStringBuilder` setter corrected the dictionary-adapter
issue. Credentials were not printed. Child processes were awaited/drained, and the
final local check found **zero fixture key directories**. `git diff --check` passed.
Root independently confirmed the final TRX counts/browser markers and queried the
exact owned database: **zero owned fixture schemas and zero public tables**. After
revalidating container identity, task labels, volume and loopback binding, root stopped
only that container with a ten-second timeout and confirmed **exited**. The same
volume and protected private configuration remain retained. Root also confirmed zero
fixture key directories, a passing final diff check, and the separate primary
SCRUM-66 checkout unchanged. Reader, schema and package sources were preserved.
No further application or database checks were run for final documentation-only
corrections. Retained setup is not a user-facing database-restart acceptance test.
