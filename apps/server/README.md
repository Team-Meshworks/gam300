# Server reader, accounts and security

This .NET 10 ASP.NET Core host contains a bounded draft-save reader, the Identity/
PostgreSQL account persistence foundation, project draft schema/access service, request-security boundary and private
administrator provisioning/reset operations. Accounts Part 5 adds explicit login, current-session,
logout and current-password change to the existing CSRF bootstrap and three administrator
POSTs. The verification evidence is recorded below; project handlers remain later work.
A parsed envelope remains
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
limit. The project draft schema is described in the SCRUM-66 section below; project
and lifecycle endpoints remain unimplemented.

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
$taskArtifacts = Join-Path (Get-Location) '.artifacts'
$taskConnectionPath = Join-Path $taskArtifacts 'scrum45-postgres-connection.txt'
$taskMetadataPath = Join-Path $taskArtifacts 'scrum45-postgres-container.json'
if ((Test-Path -LiteralPath $taskConnectionPath) -or (Test-Path -LiteralPath $taskMetadataPath)) {
  throw 'A retained setup is already recorded; revalidate and reuse it instead.'
}
New-Item -ItemType Directory -Path $taskArtifacts -Force | Out-Null
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
$taskMounts = docker inspect --format '{{json .Mounts}}' $taskContainerId | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or @($taskMounts).Count -ne 1 -or $taskMounts[0].Type -ne 'volume' -or
    $taskMounts[0].Destination -ne '/var/lib/postgresql' -or $taskMounts[0].Name -notmatch '^[a-f0-9]{64}$') {
  throw 'Cannot record exactly one new anonymous image-owned volume.'
}
$taskImageDigest = 'postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336'
$taskDigests = docker image inspect postgres:18.6 --format '{{json .RepoDigests}}' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $taskImageDigest -notin @($taskDigests)) { throw 'Official image digest mismatch.' }
New-Item -ItemType File -Path $taskConnectionPath | Out-Null
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$taskAcl = Get-Acl -LiteralPath $taskConnectionPath
$taskAcl.SetAccessRuleProtection($true, $false)
$taskAcl.SetOwner($taskIdentity)
$taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskIdentity, 'FullControl', 'Allow'))
Set-Acl -LiteralPath $taskConnectionPath -AclObject $taskAcl
[IO.File]::WriteAllText($taskConnectionPath, $env:SPATIA_TEST_DATABASE_CONNECTION)
[ordered]@{ containerId = $taskContainerId.Trim(); containerName = $taskContainerName; host = '127.0.0.1'
  port = [int]$taskPort.Trim(); database = 'spatia_scrum45_test'; username = 'spatia_test'
  imageDigest = $taskImageDigest; expectedVolume = $taskMounts[0].Name; connectionPath = $taskConnectionPath
} | ConvertTo-Json | Set-Content -LiteralPath $taskMetadataPath
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
secret ownership metadata before loading them. The last observed port was 54350 and
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
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/quality-final -- --report-trx --minimum-expected-tests 1
Remove-Item Env:/SPATIA_TEST_DATABASE_CONNECTION
Remove-Item Env:/ConnectionStrings__Spatia
```

The added tests cover design/DI model agreement, guarded database targets, migration
and role seeds, standard store resolution, normalized username races, password hashing,
account flags/stamps/UTC lockout durability, single-role/organization constraints,
invalid memberships, restricted deletion and transactional rollback without orphan
users/assignments. These Part 2 schema/manager checks did not establish HTTP authorization behavior.
Part 3 adds the request-boundary checks below, and Part 4 adds actual administration.
Part 5 supplies explicit account-session operations; account lifecycle and project access remain later work.

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
header; bootstrap again after the authenticated principal changes. The administration
and account-session routes below extend the original Part 3 boundary. No project
endpoint is shipped yet.

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
including unspecified-address aliases, are rejected at startup. The host's default
request-body ceiling is **16 KiB**. Kestrel counts HTTP/1 chunk framing within that
ceiling. This test writer emits one four-hex-digit chunk with no trailers, adding
13 framing bytes: its tested decoded boundary is 16,371 bytes, versus 16,384 bytes
with Content-Length. Chunk framing overhead is not universally 13 bytes. Part 6a
below lets the declared-length guard follow an endpoint's Kestrel limit after routing.
Every production account route keeps the default; no project endpoint exists yet.

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
five-minute lockout options. Part 3 configured those options; Part 5 below supplies
the real login handler and verifies actual lockout behavior.

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

The administrator initially requires a password change. At the Part 4 verification
gate, its tests minted sessions through routes in the test assembly. Part 5 below
adds real sign-in and first-password completion and replaces that browser shortcut.
Retained Data Protection XML is not
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

## Explicit account sessions and password completion (Part 5)

The account host maps exactly eight production routes. The four account-session
operations share the existing HTTPS, current-database principal, cookie, CSRF,
logging and body-limit boundaries:

| Route | Required JSON / authority | Success |
| --- | --- | --- |
| `POST /api/auth/login` | `userName,password`; anonymous or current full actor; CSRF; `Authentication` rate | 204 and a nonpersistent session cookie |
| `GET /api/auth/session` | `CurrentAccount`, including forced sessions | 200 `{userId,displayName,role,orgId,mustChangePassword}` |
| `POST /api/auth/logout` | `CurrentAccount`; CSRF; `AccountWrite` rate | 204 and application-cookie deletion |
| `POST /api/auth/password` | `currentPassword,newPassword`; `CurrentAccount`; CSRF; `AccountWrite` rate | 204 and refreshed same-account cookie |

Login username is unchanged, 1-256 characters, not whitespace-only and contains no
NUL. Password inputs are unchanged 12-128 characters; strict JSON rejects extra,
duplicate, wrong-case, missing or invalid-null properties. Invalid login bounds are
400 `invalid_login_input`. Shape-valid unknown/wrong credentials, disabled or locked
accounts, invalid role/org state and unsupported two-factor-enabled accounts share
401 `login_failed` and the same fixed message. No timing-equality guarantee is made.
A forced-session actor cannot escape its allowlist by logging into another account;
that login returns 403. A full actor can switch with its current CSRF token, and a
failed switch preserves its existing session.

Login explicitly requests standard Identity lockout on password failure: five failed
attempts cause five minutes of lockout, persisted in PostgreSQL. This protects new
sign-ins and does not revoke an existing session. Standard Identity lockout time uses
system UTC; the test cookie clock is not substituted for it. Tests inspect the actual
five-minute window and move only the isolated account's lockout end into the past
for deterministic recovery, without sleeps.

The session response is current nonsecret database metadata with `displayName` equal
to username and nullable organization only for the global Administrator. It uses
no-store and requires a valid current cookie. Login issues a new eight-hour absolute
session. Password completion verifies the current claim stamp against the loaded
account, requires an ordinally different password, and commits standard hash/stamp
rotation plus `MustChangePassword=false` in one transaction. Failed results/errors or
uncommitted cancellation roll back. Wrong/invalid/same password returns fixed 400;
optimistic concurrency returns 409, while a loaded stamp mismatch returns 401.
An actor already tracked by routine stamp validation can instead lose a late reset
race with 409. Neither path retries stale credentials.

Only after commit does the password operation refresh the same verified/changed
entity's session, retaining the original absolute cutoff. Routine five-minute cookie
renewal and a password refresh near expiry do not start a new eight-hour lifetime.
Concurrent reset may leave a late issued cookie with an old stamp; it fails the next
current-database check. No password verification is followed by an unverified reload
that could authorize the new stamp. A lost response can still mean a committed
credential change: try the submitted new password before requesting an explicit
administrator reset for recovery.

Fetch a new `/api/auth/csrf` token in a separate request after login, account switch,
password completion and logout. Anonymous/principal-change tokens do not interchange.
A same-user password change does not inherently invalidate an old CSRF token because
the standard binding uses identity rather than the security stamp. Logout requires a
current session and clears that browser's application cookie. It does not revoke a
separately captured cookie; this model has no individual-session revocation store.

Part 5 verification uses real HTTPS/PostgreSQL and only
standard test-side Identity/EF extension points to pause verified password snapshots,
old tracked writes and post-commit cookie creation. They check lockout durability,
rollback/cancellation, stale-stamp conflicts, forced completion and original expiry.
The browser now uses actual login/password/session/logout plus real administration;
only its HTML/protected observation probes remain test-only. It does not implement
the SCRUM-126 product UI. Part 6 restart/end-to-end acceptance and project integration
remain separate gates. No new dependency, schema or package change is required.
The locked restore, pinned tool restore and initial Release build passed with zero
warnings/errors. Production format verification passed; initial test formatting found
ten initializer whitespace differences in the new test classes. Scoped nonsemantic
formatting corrected them, then test verification and Release rebuild passed. EF
no-connect migration listing, pending-model inspection (no changes) and idempotent
SQL generation passed. The existing reviewed migration/package graph was preserved.

The first full Part 5 run executed **302 cases: 293 passed, nine failed, zero skipped**,
exit 2, in **124.725 seconds** (module 123.943 seconds). Eight failures came from the
test assertion helper disposing a cached response stream before a second JSON read;
parsing the buffered response string with a scoped `JsonDocument` fixed the helper.
The ninth was a test pause gate never installed: standard Identity
[`AddRoles`](https://raw.githubusercontent.com/dotnet/aspnetcore/v10.0.12/src/Identity/Extensions.Core/src/IdentityBuilder.cs)
replaced the earlier test claims factory. The test now uses the deferred
[`ConfigureContainer`](https://raw.githubusercontent.com/dotnet/aspnetcore/v10.0.12/src/DefaultBuilder/src/ConfigureHostBuilder.cs)
callback and asserts the wrapper actually resolves. No production behavior changed.
The corrected generic-login cases passed **8/8 in 8.431 seconds**, and the
post-commit/pre-refresh race passed **1/1 in 5.398 seconds**, after build/format checks.

The initial Part 5 TRX/HTML and browser metadata are retained in
`test-results/part5-initial/` and `.artifacts/scrum45-browser-version-part5-initial.txt`.
Focused reports are in `test-results/part5-login-focused/` and
`test-results/part5-refresh-focused/`. Part 4's final evidence remains in
`test-results/part4-final/` and `.artifacts/scrum45-browser-version-part4.txt`.
At the Part 5 gate, its test command wrote reports under `test-results/part5/`.
The final full suite passed **302 executed / 302 passed / zero failed / zero skipped**,
exit **0**, in **108.397 seconds** (module 107.892 seconds). The TRX confirms the
251 prior cases plus **44 account-session** and **7 credential-operation** cases.
The existing host/principal/browser cases now exercise the real route integration;
the 74 reader tests remain unchanged. Final reports are
`test-results/part5/Spatia.Server.Tests_net10.0_x64.trx` and
`test-results/part5/Spatia.Server.Tests-windows-net10.0-report.html`.

The actual final browser used **Node 24.19.0**, **Playwright 1.63.0** and
**Chromium 153.0.8010.12**, with administration, CSRF and session-lifecycle pass
markers in `.artifacts/scrum45-browser-version.txt`. This flow uses real login,
first-password completion, provisioning/reset, logout and account switching; it
does not substitute a product UI or establish Part 6 database-restart acceptance.
Release build and test-format verification passed again after the test-only
corrections. Production formatting and all EF checks had already passed; no later
model or schema change required repeating those checks.
No production/test/browser source changed after the final full run began; only
README evidence was updated. No unchanged passing suite was repeated for prose.

Before execution, the exact retained container ID/name/task labels/owned volume and
loopback binding were revalidated; only that container was started. Its dynamic port
was privately refreshed to **54350**, with no credential output. Successful test
helpers awaited their owned subprocesses and drained in-flight requests. Local final
checks found **zero fixture key directories** under both known artifact roots, and
`git diff --check` passed. Root independently parsed the final **302/302** counters
and all ten test-group counts, read all three final browser markers/versions and
confirmed the installed Playwright **1.63.0** package. Root confirmed **zero fixture
key directories** and no production/test/browser source modification after the final
run. Its guarded exact-container query returned **spatia_scrum45_test, zero owned
fixture schemas and zero public tables**. After revalidating ID/name/task labels,
owned volume and loopback binding **54350**, root stopped only that container with
a ten-second timeout and confirmed **exited**. The same volume and protected private
configuration remain retained. Root also verified an empty index, the 22 intended
changed/new server files and the primary SCRUM-66 checkout clean and unchanged.
Part 5 passed final review; no extra application/database execution followed these
documentation-only updates. Part 6 restart/end-to-end and product/project integration
acceptance remain separate work.

## Isolated API and database restart acceptance (Part 6)

Part 6 adds a separate, explicit acceptance runner; ordinary `dotnet test` does not
restart Docker or invoke it. It starts the actual Release `Spatia.Server.dll`, uses
the existing private bootstrap command and eight production routes, and cold-starts
a different API process after restarting only the retained disposable PostgreSQL
container. It preserves the same generated schema, Data Protection key ring and
`Testing` environment across that restart. No production test route, dependency,
schema change or product frontend is added. This standalone acceptance replaces the
old in-process API-rebuild test. Run it after Data Protection/key-storage, account
persistence or relevant host changes; the ordinary TUnit suite no longer establishes
cold API/database restart behavior.

Run from `apps/server/` in **PowerShell 7.4+ on Windows**, after the canonical locked
restore/tool restore/Release build and source review. The runner does not restore or
build implicitly. Docker Desktop must already be running. The existing private
connection and nonsecret ownership files must identify the exact recorded SCRUM-45
container selected by that ownership record; the runner refuses mismatched identity, shared
storage, image or non-loopback mapping. A new checkout must establish and review
its own disposable setup and save the ownership/private files using the fresh-setup recipe above; no source identity edit is needed. Do not point it at a
partner, pilot, Wiki.js or shared database.

Use the installed Playwright **1.63.0** module and its existing Chromium cache; no
browser/package install is performed by this runner. For the managed checkout,
point `PLAYWRIGHT_MODULE` to the installed module in the separate primary checkout
if that is where dependencies are available. These paths contain no credentials:

```powershell
$env:PLAYWRIGHT_MODULE = 'C:/Users/kille/Documents/GitHub/gam300/apps/web/node_modules/playwright/index.mjs'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $env:LOCALAPPDATA 'ms-playwright'
pwsh -NoProfile -File tests/restart-acceptance.ps1 `
  -ExpectedVolume (Get-Content .artifacts/scrum45-postgres-container.json -Raw | ConvertFrom-Json).expectedVolume
```

The default Docker/.NET executable paths and ignored ownership/private connection
paths can be supplied through the corresponding script parameters. The expected
volume is nonsecret ownership evidence, not a database credential. An older retained
record without `expectedVolume` requires supplying its independently recorded volume
explicitly; the runner records that field only after verifying the actual mount. The script
rechecks the exact container ID/name/task/disposable labels, official image digest,
sole image-owned volume and loopback binding before mutations. TCP readiness uses
`pg_isready -h 127.0.0.1 -p 5432`; `current_database()` must match the test database, and actual `version()` must identify PostgreSQL 18.6.
Every restart rereads the automatically assigned host port and updates only the
protected private connection and nonsecret metadata. It never dumps container
configuration or emits a connection string.

Each run creates one `spatia_scrum45_<guid>` schema and one ignored
`.artifacts/restart-<guid>` directory. The existing EF CLI applies the reviewed
migration only with that schema's private search path. The directory has an explicit
current-user Windows ACL and contains a short-lived synthetic PFX plus the retained
key ring; its random PFX password is passed only in child process environment.
Bootstrap credentials go through redirected stdin. API/EF output is captured and
checked privately, and credential sentinels cannot enter the fixed result artifact.
The Node child receives no database or host-secret configuration. TLS checks are
relaxed only for these loopback synthetic-certificate readiness/browser requests;
no machine certificate store or trust configuration is changed.

The browser provisions an organization and forced Creator through a real full
Administrator session. It records exact account/org metadata, retains the admin
cookie privately, and signals the restart checkpoint. After the old API PID exits,
the exact PostgreSQL container stops/starts and a different API PID is ready, the
retained browser must recover the same admin session with byte-identical protected
cookie. The flow remains below the routine renewal interval, proving the same
absolute-cutoff ticket decrypted using persisted keys. A separate fresh browser
context must initially be anonymous, then sign in to the persisted Creator with
the same IDs/org/forced state, change its initial password, log out and lose access.
Another fresh context rejects the temporary password and signs in with the
replacement password. Cookie attributes and empty browser token storage are checked.
Existing TUnit tests retain the separate lockout/expiry/stamp/CSRF and race coverage;
this acceptance does not duplicate those cases or claim a product UI.

The runner bounds and drains its child processes, leaves PostgreSQL running for
independent catalog inspection, and removes only its exact generated schema and
validated generated directory. If a child cannot stop or cleanup fails, it preserves
and records the residue rather than deleting resources still in use. Failure
recovery can start only the same revalidated owned container. The result is a new
nonsecret `.artifacts/restart-acceptance-<guid>.json` containing fixed stage/failure
information, API PIDs, actual PostgreSQL version, current port, cleanup flags and browser versions/pass markers. A child that cannot exit retains its owned PID in that evidence.
It does not print raw child output, credentials, cookies or tokens.

Part 6 passed on **18 October 2026** after independent source review. PowerShell
parsing (PowerShell **7.6.5**), Node syntax, locked restore, local tool restore,
Release build (**zero warnings/errors**) and both format checks passed. Docker's
engine was initially unavailable; the existing Desktop executable was started
hidden, and engine **29.8.0** became ready within the bounded check. No application
behavior or source correction was needed during execution.

The wrong-valid-volume negative check exited **1** before mutation. Independent
checks found the container still exited with unchanged start timestamp, unchanged
private configuration/metadata and no created schema/directory. Its fixed outcome
is retained in `.artifacts/restart-acceptance-e1126275ad044dac9bfbca9426f0fdfe.json`.
The first positive acceptance passed, exit **0**, in **20.556 seconds**. The actual
API PIDs changed **23804 → 24324** across the owned database restart. All three
browser markers passed with **Node 24.19.0**, **Playwright 1.63.0** and
**Chromium 153.0.8010.12**. The queried server was **PostgreSQL 18.6**, Debian
`18.6-1.pgdg13+2`. Its dynamically assigned loopback port was refreshed to **50391**.
Full nonsecret evidence is retained in
`.artifacts/restart-acceptance-6fd435a956194aca8bef37827a33c9ed.json`.

The runner confirmed its schema and temporary directory removed, no cleanup
failures and no retained child PIDs. Root independently revalidated the exact owned
container ID/name/task/disposable labels/anonymous volume/loopback binding, then
queried **spatia_scrum45_test, zero owned fixture schemas and zero public tables**;
its independent temporary-directory count was also zero. PostgreSQL remained running
at this Part 6 gate for the subsequent focused test-quality verification; the final
stop after that verification is recorded below. The previous **302-case Part 5**
suite was preserved and not repeated
for the isolated restart change. A later quality-suite result is not implied by this
acceptance. Parts 7–8 and product/frontend integration remain incomplete.

Parts 7–8 remain blocked on actual project implementations. The 18 October dependency
inspection found the primary SCRUM-66 checkout still contains only the bounded save
reader, and no C# production project store on the freshly fetched origin refs.
Part 7 needs SCRUM-66 schema/storage/current-authorized list/open; Part 8 additionally
needs the SCRUM-50 server validator for valid create/duplicate writes. These account
routes and test fixtures do not substitute either dependency.

## Test-quality review and final verification — 18 October 2026

The review removed **ten redundant executed cases** (seven methods and three
parameter cases), reducing the normal suite from 302 to **292**. The coverage map is:

- Direct duplicate inserts and a hand-built provisioning transaction are covered by
  actual provisioning endpoint duplicate races, sequential normalized conflicts and
  rollback checks that also verify final persisted counts.
- Synthetic cookie/identity-transition assertions are consolidated into real login,
  session, account-switch and browser flows; the three login roles still verify the
  bounded nonpersistent cookie, including absence of `Max-Age`.
- Repeated password-policy/options boundaries are covered by actual credential
  operations; one manager-level **129-character rejection with no persisted user**
  remains to detect loss of the composed maximum-length validator.
- The old in-process key/rebuild case is replaced by the separately executed Part 6
  **cold API process + PostgreSQL restart** acceptance above. Run that standalone
  command after key-storage/Data Protection, auth-persistence or relevant host
  changes; an ordinary TUnit pass does not establish restart behavior.

The **74 reader cases**, real migration/seed/store behavior, schema constraints,
current-principal/status/stamp checks, exact expiry, lockout, CSRF, safe errors/logging,
transaction rollback/cancellation and all **seven credential-operation cases** remain.
Production code, dependencies and migrations were unchanged by the quality review.

Release build passed with **zero warnings/errors** and both format checks passed.
The four focused methods executed **six cases, all passed**: duplicate race **1/1 in
5.413s**, real login **3/3 in 5.401s**, manager maximum **1/1 in 4.002s**, and migration
**1/1 in 3.634s**. Each has TRX/HTML evidence under
`test-results/quality-focused/{duplicate,login,password,migration}/`. They used
`--treenode-filter /*/*/*/<method>` with the actual method names in the source.

One final full suite then passed **292 executed / 292 passed / zero failed / zero
skipped**, exit **0**, in **93.541s** (module **93.059s**). Its groups are **74 reader,
8 persistence, 6 model, 44 session, 68 administration, 20 bootstrap, 7 credential,
43 host, 12 principal and 10 security**. Reports are
`test-results/quality-final/Spatia.Server.Tests_net10.0_x64.trx` and
`test-results/quality-final/Spatia.Server.Tests-windows-net10.0-report.html`.
There were no quality-run failures or test fixes. Restore/model/restart checks were
not repeated for these test-only edits; the accepted isolated Part 6 result remains
separate. No production/test/browser source changed after the final run started.

The final normal browser passed all three administration/CSRF/session markers with
**Node 24.19.0** and **Chromium 153.0.8010.12**, using the same installed **Playwright
1.63.0** module. Its metadata is `.artifacts/scrum45-browser-version.txt`; the accepted
Part 5 metadata was copied to `.artifacts/scrum45-browser-version-part5-final.txt`
before the wrapper ran. All prior TRX/HTML and restart outcomes were preserved.

Root independently confirmed the **292/292** counters and all ten group counts,
read the browser markers/versions, and found **zero `https-<32hex>` or
`restart-<32hex>` directories** under both server and test-output artifact roots.
Its guarded final query returned **spatia_scrum45_test, zero owned fixture schemas,
zero public tables**. Root revalidated the exact container ID/name/task/disposable
labels and sole owned anonymous volume, stopped only that container with
`--timeout 10`, and confirmed **exited** with its volume/private configuration retained.
This supersedes the earlier running-container gate. Parts 7–8 remain blocked as
recorded above. No extra application/database execution followed these final prose
updates.

## SCRUM-66 Part 3 — project draft schema

`Projects.Project` and `Projects.ProjectAssignment` use the existing
`ApplicationDbContext`, Identity UUID keys and PostgreSQL database. Migration
`20261018091152_AddProjectDraftStorage` adds only `projects`, `project_assignments`
and their constraints/indexes; it does not rewrite the initial Identity migration.
The project record stores organization/archive metadata, the authored JSON in
`jsonb`, a separate server revision/schema version, a UTC update instant and nullable
last-mutation actor/ID/digest. Assignments have one project/user pair with explicit
edit/manage/publish flags.

Database checks enforce revision `0..9007199254740991`, a positive schema version,
a JSON object whose root ID and schema version match the relational columns, and a
finite timestamp. The JSON check uses `IS TRUE` so missing or JSON-null metadata
cannot pass through SQL's NULL check semantics. Last-mutation metadata is either
entirely absent or complete with a 32-byte digest. Foreign keys use restricted
deletion and assignments are unique per project/user. Revision is an EF concurrency
token; callers must still implement the later atomic save and authorization protocol.

These checks are structural safeguards, not a project validator or access policy.
The test documents are trusted synthetic database fixtures and need not be complete
authored projects. `jsonb` cannot preserve duplicate JSON keys for later validation;
the original bounded request must pass SCRUM-50 validation before production writes.
There are no project ingestion/save/read endpoints, permission checks, project-row
locks or mutation-reconciliation service in this slice. A stale EF update check
does not establish the authorized-save concurrency acceptance criteria.

`ProjectPersistenceTests` reuses `PostgresAccountFixture`. Its optional migration
target is used only to start the upgrade regression at the actual initial Identity
migration, seed a real account/role/organization/membership, then apply the project
migration and verify preservation. Other callers still migrate to latest. Fixtures
create fresh owned schemas inside the guarded disposable database; they do not
create a new database or migrate public/shared data.

The focused cases cover round-trip storage, actual migration upgrade, relational
constraints/deletion, revision/document/timestamp/mutation boundaries, transactional
rollback and stale EF updates with persisted-state verification. The successful
roundtrip verifies the exact digest bytes `0..31`, JSON array order/values and
assignment flags after reopening the connection.

After revalidating the owned disposable target and privately configuring both
`SPATIA_TEST_DATABASE_CONNECTION` and `ConnectionStrings__Spatia`, these commands
ran from `apps/server/`:

```powershell
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part3-focused -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/ProjectDatabase_*'
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part3 -- --report-trx --minimum-expected-tests 1
```

Verified on **18 October 2026**: the focused run passed **37 executed / 37 passed /
zero failed / zero skipped**, exit **0**, in **9.513 seconds** (module 9.047 seconds).
One complete full suite then passed **329 executed / 329 passed / zero failed /
zero skipped**, exit **0**, in **100.103 seconds** (module 99.629 seconds): the
committed 292-case baseline plus 37 project cases. Both TRX counters were independently
parsed. Each results directory above contains `Spatia.Server.Tests_net10.0_x64.trx`
and `Spatia.Server.Tests-windows-net10.0-report.html`. The full suite's existing
browser case retained its administration, CSRF and session pass markers with
**Node v24.19.0 / Chromium 153.0.8010.12**; no separate browser/restart acceptance
was run for this schema slice.

The initial test-source build reported ten nullable diagnostics because the pinned
TUnit exception assertion returns a nullable exception. Handling that return value
corrected the test source; the final Release build passed with **zero warnings and
zero errors**, and both project format checks passed. Production behavior and
existing account/reader tests were unchanged for these corrections.

The first runtime attempt was interrupted after connection-refused failures against
the retained configuration's stale port. PowerShell adapted an ordinary
`DbConnectionStringBuilder.ConnectionString` assignment as a dictionary entry, and
a nonterminating guard error allowed execution to continue. No complete aggregate
result was captured for that interrupted attempt. The corrected execution preflight
uses `$ErrorActionPreference = 'Stop'` and direct .NET `set_ConnectionString`,
`set_Item` and `get_ConnectionString` methods. Both process-memory environment
targets and actual `current_database()` were verified before retrying the focused
run. No application or migration source change was required.

The existing accounts-owned container was revalidated by its exact ID/name, official
image digest, task/disposable labels, sole owned volume and literal-loopback binding.
Its run port was **127.0.0.1:53094**; that port is historical and must be inspected
again after a later start. The private connection was read from the retained accounts
worktree, and its port changed only in process memory. The original private connection
and metadata files retained their hashes. No credentials were copied into this checkout.

Final guarded catalog inspection returned **spatia_scrum45_test, zero fixture schemas
and zero public tables**. Both known artifact roots had zero generated HTTPS/restart
temporary directories. The exact container was revalidated and stopped with
`--timeout 10`; its **exited** state and retained volume were confirmed. The fresh-schema
and actual Identity-upgrade evidence above does not establish current-authorized
project reads, row-lock save protocols, mutation reconciliation or fresh-browser project
persistence. Those later SCRUM-66 integration gates and SCRUM-50 validation remain.

## SCRUM-66 Part 4: current-authorized reads and shared row locks

`ProjectAccessService.ReadAsync(HttpContext, Guid, CancellationToken)` owns a
repeatable-read transaction. It rechecks current database account authority and
reads the permitted project/assignment projection in that same snapshot. Existing
caller transactions are rejected. Results contain either a detached immutable
`Snapshot` with explicitly unvalidated document JSON, or a `Failure` without any
document, revision or mutation metadata.

The existing cookie validator installs an internal session feature only after
successful validation. It retains the original protected eight-hour cutoff and
clock. Both service operations require that feature, an authenticated principal
with matching unique ID/stamp claims, and fresh database authority. They reject
forced-password sessions and recheck the original cutoff after awaited work.
Role and organization claims, imported JSON and returned UI permissions grant no access.

Creators require a same-organization edit assignment; they cannot manage, and
publishing additionally requires the publish flag. Educators require a
same-organization manager assignment and then have edit/manage/publish permission.
Valid global Administrators have those permissions across organizations, including
inactive target organizations, without needing an assignment. Archived projects
remain readable, with edit/publish false and management retained.

`LockAsync(HttpContext, Guid, ProjectLockPurpose, CancellationToken)` requires a
caller-owned read-committed transaction. It acquires the parameterized project-row
`FOR UPDATE` lock before rechecking current account, assignment and archive state.
`EditDraft` and `ManageAssignments` require a nonarchived project;
`ChangeArchiveState` permits an authorized manager to restore an archived project.
The caller must commit, roll back or dispose its transaction on every outcome,
including denial and cancellation. The helper never owns that transaction.

Assignment/archive writers must adopt this same lock protocol. Separate account
and organization changes receive current checks but have no stronger commit-order
revocation guarantee. A repeatable-read response can represent the complete earlier
snapshot when revocation commits afterward; a new operation checks again.

`ProjectAccessTests` uses actual protected cookies, current account resolution and
PostgreSQL through the existing HTTPS/schema fixtures. Its routes are test-only
operation probes, not product project endpoints. Synthetic project documents test
relational access and need not be complete authored projects. Bounded gates and
observed backend lock waits control races. Source review is complete. On 18 October,
`dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore` passed with
zero warnings/errors, followed by both production/test
`dotnet format <project> --verify-no-changes --no-restore` checks. The first test
build found a raw-string fixture syntax error; increasing its interpolation delimiter
corrected it. Test format verification found nine initializer whitespace issues,
which were corrected; the subsequent build and format checks passed. No package
or dependency changed, so restore was not repeated.

After revalidating the retained disposable PostgreSQL target and setting both
connection environments privately in process memory, these commands ran from
`apps/server/`:

```powershell
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part4-focused -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/ProjectAccess_*'
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part4-fixture-corrected -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/ProjectAccess_IdsImportedHintsAndInsufficientFlags_DoNotGrantAccess*'
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part4 -- --report-trx --minimum-expected-tests 1
```

On **18 October 2026**, the first focused run executed **50 cases: 49 passed,
one failed, zero skipped**, exit **2**, in **26.750 seconds** (module 25.970).
The other-student setup directly inserted a synthetic account without the required
`NormalizedUserName`, causing PostgreSQL `23502` before the operation ran. Adding
that required fixture field corrected the setup; no production change was needed.
The subsequent Release build passed with zero warnings/errors and test formatting
passed. Initial TRX/HTML reports remain in `scrum66-part4-focused` and are also
preserved in `scrum66-part4-focused-initial`.

Discovery-only attempts to select one parameter row matched zero cases, including
exit **8** and **1** attempts; they executed no tests and establish no passing
evidence. The supported method-prefix filter above then ran the affected seven
cases: **7 executed / 7 passed / zero failed or skipped**, exit **0**, in
**8.060 seconds** (module 7.539). The other 43 unchanged focused cases were not
separately repeated.

One full integrated suite then passed **379 executed / 379 passed / zero failed
or skipped**, exit **0**, in **128.714 seconds** (module 128.200). Its TRX contains
379 passing result entries: the existing 329-case baseline and all 50 access cases.
Each results directory contains `Spatia.Server.Tests_net10.0_x64.trx` and
`Spatia.Server.Tests-windows-net10.0-report.html`. The shared cookie feature and
HTTPS-fixture changes justify this full regression run. The suite's existing
browser case retained administrator, CSRF and session markers with **Node v24.19.0 /
Chromium 153.0.8010.12**. No separate browser or restart acceptance was run.

The exact retained container was revalidated against its name, official PostgreSQL
18.6 image digest, SCRUM-45/disposable labels, sole owned volume and literal-loopback
binding before start and stop. Its historical run address was **127.0.0.1:56641**.
Fail-fast preflight used direct .NET connection-string accessors, verified both
process-memory environment targets against that current port and checked the actual
disposable database before execution. The original private configuration remained
unchanged. Final catalog checks returned **spatia_scrum45_test, zero fixture schemas,
zero public tables**; both known primary artifact roots contained zero generated
HTTPS/restart directories. The exact container was stopped with `--timeout 10` and
confirmed **exited**, retaining its volume and private configuration.

This evidence establishes the bounded read/lock/session protocol with actual
cookies and PostgreSQL. SCRUM-50 validation, atomic saves/retry reconciliation,
SCRUM-69 assignment/archive writer integration, product GET/PUT handlers and project
browser/restart acceptance remain later work. It does not complete SCRUM-66 or its
parent acceptance criteria.

## SCRUM-66 Part 5a: revision and retry decisions

`ProjectSavePolicy.Decide` implements the document-independent revision and
latest-mutation rules. It takes an existing `ProjectAccessSnapshot`, expected
revision, mutation ID and an opaque 32-byte request digest. It returns
`WriteRequired`, `Replay`, `Conflict` or `RevisionExhausted` without modifying
state or returning a save acknowledgement. `Project.MaxRevision` shares the
existing exact-integer limit with the bounded envelope reader.

A latest retry replays only for the same mutation ID, actor, digest and original
revision (current revision minus one). Changed reuse conflicts. A different
mutation requires the current revision, even if its content is identical. New
writes cannot advance past the revision limit; the latest exact retry can still
replay at that limit. Invalid ranges, digest lengths, incomplete stored mutation
metadata and noneditable snapshots are rejected as caller errors.

This policy does not establish authorization or content validity. Its future
caller must use the actual `EditDraft` lock, retain the transaction, validate
through SCRUM-50 and compute the digest on the server using the agreed document
representation plus project/actor/original revision. No client digest is trusted.
SCRUM-50 TODOs mark those integration points. At the Part 5a checkpoint the policy
had only test callers; the subsequent Part 5b storage helper below also uses it.
The policy itself enables no save route, database write, validator or digest generator.

Only the latest mutation is remembered. An older retry after a newer revision
conflicts; arbitrary reuse of historical IDs with a fresh revision cannot be
detected by this one-slot model. SCRUM-69 assignment/archive writers must clear
all three last-mutation fields when advancing the common revision so the old save
cannot be replayed as a metadata edit. Their integration is still outstanding.

Verification from `apps/server/`:

```powershell
dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore
dotnet format Spatia.Server/Spatia.Server.csproj --verify-no-changes --no-restore
dotnet format tests/Spatia.Server.Tests.csproj --verify-no-changes --no-restore
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part5a-policy -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/SavePolicy_*'
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part5a-reader -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/SaveEnvelopeReaderTests/*'
```

The final Release build passed with zero warnings/errors; both formats passed.
Policy checks passed **28/28** (2.946 seconds), and affected reader checks passed
**74/74** (2.715 seconds), both exit 0 with zero failed/skipped. The TRX counters
and all 102 result entries were inspected. The first build found
five test-only CS1061 errors from awaiting TUnit's synchronous `Assert.Throws`;
using synchronous tests corrected them. Production logic needed no correction.

These are pure policy/parser checks. PostgreSQL, browser and the unchanged full
suite were not rerun; no transaction/commit/concurrency guarantee is claimed by
this slice. Validated atomic saves, digest generation, safe acknowledgements and
the remaining Part 5 integration still require SCRUM-50 and further database tests.

## SCRUM-66 Part 5b: conditional draft storage

`ProjectSaveWriter.TryStageAsync` stages a conditional update inside the caller's
ReadCommitted transaction. It reuses the revision/retry policy, then binds the
document, schema version, revision increment, database UTC timestamp and complete
mutation slot in one parameterized PostgreSQL update. The predicate requires the
same project, organization and revision, with the project still nonarchived.
It never inserts a missing project. See PostgreSQL's [UPDATE row-count
semantics](https://www.postgresql.org/docs/18/sql-update.html#SQL-UPDATE-OUTPUTS).

`true` means exactly one row was staged; `false` means the policy did not permit a
new write or no row matched. Neither result acknowledges a saved project. The
caller owns commit/rollback/disposal on every path, and SQL/cancellation errors
propagate. The helper does not refresh EF-tracked objects; read the staged
revision/time without tracking when preparing a future acknowledgement, and send
that acknowledgement only after a successful commit.

At the Part 5b checkpoint, the helper had no DI registration, production caller or
HTTP route. Part 5c below adds an unregistered internal coordinator. The TODOs
require its future production entry point to perform actual SCRUM-50 supported-version/field/
reference validation, obtain current `EditDraft` authority, and compute the request
digest on the server using the agreed representation. The SQL metadata checks and
synthetic test documents do not provide domain validation. HTTP conflict/replay
responses, lost-acknowledgement reconciliation and SCRUM-69 writer integration
remain unfinished; Parts 5–7 and parent acceptance are still open.

Verification from `apps/server/`, on **19 October 2026**:

```powershell
dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore
dotnet format Spatia.Server/Spatia.Server.csproj --verify-no-changes --no-restore
dotnet format tests/Spatia.Server.Tests.csproj --verify-no-changes --no-restore
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part5b-writer -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/SaveWriter_*'
```

The final Release build passed with zero warnings/errors in **6.37 seconds** using
SDK **10.0.401**. Both format checks passed; their initial sandboxed attempts were
unable to access the local MSBuild pipe, and passed when that access was allowed.
No source fix was needed. The focused PostgreSQL run passed **16/16**, zero
failed/skipped, exit 0, in **7.571 seconds** (module **6.619 seconds**). Its TRX
counters and all 16 passing result entries were inspected. TRX/HTML reports are
under `test-results/scrum66-part5b-writer/`.

The checks cover all staged fields and preserved array order, independent-connection
visibility before/after commit, explicit rollback, an actual deferred-constraint
commit failure with related writes rolled back, SQL constraint failure, transaction
ownership/isolation, policy rejection, zero-row predicates without upsert, competing
same-revision writes after either commit or rollback, and cancellation during an
observed database lock wait. Bounded `pg_blocking_pids` observations control the
races. These lower-level checks do not replace current-authorization/validator/API
integration tests.

Only the retained disposable PostgreSQL **18.6** container was restarted after
checking its exact identity, image digest, labels, sole owned volume and loopback
binding. Its run port was **127.0.0.1:49900**; future runs must inspect it again.
The retained private connection's port was refreshed only in process memory.
Final guarded inspection returned `spatia_scrum45_test|0|0`: zero fixture schemas
and zero public tables. Both known artifact roots had zero generated HTTPS/restart
temporary directories, and the private connection/ownership files kept their
original hashes. The exact container was stopped and confirmed exited, retaining
its volume and configuration.

No dependency, schema, shared fixture, authentication or HTTP behavior changed.
The unchanged full suite, browser and restart acceptance were not repeated for this
unregistered storage helper. A complete validated, authorized save workflow and
saved-project browser/restart acceptance remain outstanding.

## SCRUM-66 Part 5c: authorized save transaction coordination

`ProjectSaveService.SaveAsync` composes the existing access lock, retry policy and
conditional writer. It owns a ReadCommitted transaction and rejects a caller-owned
transaction. Current `EditDraft` authority is checked before a revision or retry
result is disclosed. New writes read their authoritative revision/time without
tracking and return `ProjectSaveAcknowledgement` only after commit; matching latest
retries return the stored acknowledgement without another write. Access denial
contains neither an acknowledgement nor a current revision.

The original session cutoff is checked after awaited work and commit. Expiry before
commit rolls back; expiry, cancellation or a failure after a durable commit suppresses
success but cannot undo that commit. Exceptions propagate without automatic retry.
Reconciliation must retain the original mutation ID and request: an authorized
exact retry either applies an uncommitted save or recognizes the latest durable one.
The existing bounded guarantee for independent account/organization changes still
applies; SCRUM-69 assignment/archive writers must adopt the shared lock protocol.

This coordinator has no DI registration or production request caller. SCRUM-50
TODOs remain at the service entry point, document/schema/route acceptance and
server-derived digest inputs. Tests supply synthetic documents and opaque digests;
they prove transaction composition, not domain validation or a hosted save API.
No validator, digest algorithm, endpoint, request limit, schema, dependency or shared
fixture was added. Protected project GET/PUT, validated saves and saved-project
browser/restart acceptance remain incomplete.

Verification from `apps/server/`, on **19 October 2026**:

```powershell
dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore
dotnet format Spatia.Server/Spatia.Server.csproj --verify-no-changes --no-restore
dotnet format tests/Spatia.Server.Tests.csproj --verify-no-changes --no-restore
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part5c-service -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/SaveService_*'
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part5c-retry-corrected -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/SaveService_ChangedLatestMutationIdentityConflictsWithoutAnotherWrite*'
```

Release build passed with zero warnings/errors using SDK **10.0.401**; the build
after the fixture correction took **3.53 seconds**. Both format checks passed,
including the corrected test source. The first focused run passed **17/18**, with
one failed and zero skipped, exit 2, in **17.657 seconds** (module **16.614**).
The actor-change fixture tried to change a tracked composite-key property; EF
rejected that setup before the service call. Replacing that setup with a bound SQL
membership update required no production fix. Its three retry-identity cases then
passed **3/3**, zero failed/skipped, exit 0, in **7.419 seconds** (module **6.422**).
Both TRX reports and individual outcomes were inspected. All 18 distinct cases
have passing evidence across those runs; no fresh full 18-case pass is claimed.
The original and corrected TRX/HTML reports remain in the two result directories.

Actual protected Identity cookies, CSRF and PostgreSQL were used through test-only
operation probes. Cases cover committed save/latest replay/new revision/older retry,
changed digest/actor/original revision, denied matching retries, assignment revocation
during an observed lock wait, identical/different concurrent saves, commit failure,
uncertain post-commit failure/cancellation, session expiry before/after commit,
zero-row refusal, revision exhaustion and caller-transaction ownership. Bounded
`pg_blocking_pids` checks and commit/command interceptors control race timing.

The same retained disposable PostgreSQL **18.6** container was revalidated by exact
identity, image digest, labels, sole volume and loopback binding. This run used
**127.0.0.1:65120**; future runs must inspect the port again. Credentials and refreshed
port stayed in process memory. Final catalog inspection returned
`spatia_scrum45_test|0|0`; both known artifact roots had zero generated HTTPS/restart
directories, and private configuration hashes were unchanged. The exact container
was stopped and confirmed exited with its original volume retained.

The unchanged policy, reader, writer and full suites were not repeated. Browser and
restart acceptance were not rerun because the coordinator has no product endpoint
or affected browser flow. This completes only the independent Part 5c slice.

## SCRUM-66 Part 6a: endpoint-specific request limits

The host keeps its 16 KiB Kestrel default and rejects insecure transport before
routing. Its declared Content-Length guard now runs immediately after routing and
reads the active `IHttpMaxRequestBodySizeFeature` limit, before authentication,
rate limiting, authorization and CSRF. This allows a specifically marked endpoint
to use the larger save budget while existing account routes, wrong methods and
unmatched routes retain 16 KiB.

ASP.NET Core's [10.0.12 routing implementation](https://github.com/dotnet/aspnetcore/blob/v10.0.12/src/Http/Routing/src/EndpointRoutingMiddleware.cs)
already applies standard `RequestSizeLimitAttribute` metadata to Kestrel before body
reads. No custom limit middleware, marker type or path-matching exception is needed.
The existing `SaveEnvelopeReader.MaxRequestBytes` constant is now public so the
reader and eventual PUT metadata share the 6 MiB value. The separate document limit
remains 5 MiB and compressed request bodies remain unsupported.

Only `ProjectRequestBoundaryTests` maps a PUT probe with
`RequestSizeLimitAttribute(SaveEnvelopeReader.MaxRequestBytes)` and calls the real
bounded reader. It neither validates authored content nor saves it. Production
still exposes only the eight account routes. The host TODO requires actual
SCRUM-50 integration before project GET/PUT registration; reader and save-service
validation/digest TODOs remain. Safe response mapping, validated reads/writes and
saved-project browser/restart acceptance still need the remaining Parts 5–7 work.

The focused HTTPS checks cover exact/overflow declared lengths and single-chunk
transport, the independent document budget, compressed oversized content,
session/forced-change/CSRF rejection and default limits on account/unmatched/
wrong-method requests. They verify safe no-store problem responses without leaking
the submitted marker to responses or logs. For the six-hex-digit test chunk,
15 framing bytes count toward Kestrel's 6 MiB cap. Framing overhead varies with
chunk layout; the reader counts decoded body bytes separately.

The declared-length boundary check uses `Expect: 100-continue` so the client can
receive the early 413 before uploading. Its first attempt without the handshake
hit an `HttpRequestException` while uploading after the server closed the rejected
connection. An already-uploading client can therefore observe a transport failure;
the correction changes test transport only and does not relax or drain past the
server's body limit. The chunked cases continue to stream their bodies.

Verification from `apps/server/`, on **19 October 2026**:

```powershell
dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore
dotnet format Spatia.Server/Spatia.Server.csproj --verify-no-changes --no-restore
dotnet format tests/Spatia.Server.Tests.csproj --verify-no-changes --no-restore
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part6a-limits -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/RequestLimits_*'
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part6a-limits-corrected -- --report-trx --minimum-expected-tests 1 --treenode-filter '/*/*/*/RequestLimits_EndpointMetadataAndReaderShareTheSixMiBBoundary*'
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results/scrum66-part6a-full -- --report-trx --minimum-expected-tests 1
```

Release build passed with zero warnings/errors using SDK **10.0.401**; the final
build after the test-only handshake correction took **2.71 seconds**. Both formats
passed, including the corrected test file. The initial focused run passed **12/13**,
one failed/zero skipped, exit 2, in **11.358 seconds** (module **10.329**), with the
upload error described above. The affected four cases then passed **4/4**, zero
failed/skipped, exit 0, in **6.601 seconds** (module **5.750**).

One full backend run passed **454/454**, zero failed/skipped, exit 0, in
**149.978 seconds** (module **149.496**). This was warranted by the shared host
ordering change; it includes all 13 new boundary cases and the existing real-browser
account flow. All three TRX reports were inspected, including those 13 results and
the browser result in the final report. The fresh browser artifact records
**Node 24.19.0 / Chromium 153.0.8010.12** and passing administration, CSRF and session
markers; installed **Playwright 1.63.0** was also checked. TRX/HTML files remain in
the three result directories above; browser evidence is in
`.artifacts/scrum45-browser-version.txt`.

The first runtime preflight found Docker Desktop stopped and did not touch the
database. Its installed CLI started the local engine, then the retained disposable
PostgreSQL **18.6** container was revalidated by exact identity, image digest, labels,
sole volume and loopback binding before use. The run port was **127.0.0.1:63553**;
future starts require a fresh port check. Credentials and the updated port remained
only in process memory. Final guarded inspection returned `spatia_scrum45_test|0|0`,
with zero matching temporary directories in both artifact roots and unchanged
private configuration hashes. The exact container was stopped and confirmed exited
with its volume retained. With no containers running, Docker Desktop was returned
to its initial stopped state.

No dependency, schema, shared fixture or production route changed. Unchanged
restore/model/migration checks and separate restart acceptance were not repeated.
Part 6a is complete; full Part 6 and SCRUM-50 integration remain open.

### Remaining Part 6 work (19 October audit)

Project-specific HTTP result mapping is still unimplemented and can be prepared
independently of SCRUM-50: map the existing access/save outcomes to safe problems,
disclose current revisions only on authorized conflicts, and return only committed
save acknowledgements. Reuse `ApiProblems` and the existing host security/error
handling; focused response/privacy checks are the next independent slice.

Production GET/PUT still require SCRUM-50's actual C# validator, shared fixtures,
supported-version handling and agreed request-digest representation. The host has
separate TODOs for validator/save-service registration, validated GET, validated PUT
with the shared 6 MiB metadata, and safe 422 validation errors. The internal read
snapshot also marks its public-envelope boundary: actor/organization/retry metadata
must not be serialized into the document/revision/time/permissions response.

This audit changes comments and documentation only. Source comparison verifies
unchanged executable lines; no application, PostgreSQL or browser suite was rerun.
The prior 454/454 result remains evidence for Part 6a, not completed project APIs.
