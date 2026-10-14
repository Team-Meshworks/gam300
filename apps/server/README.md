# Save request boundary

This slice is a .NET 10 class library for parsing a bounded draft-save request. It
contains no running API host, routes, authentication, project validator, EF model,
migration or PostgreSQL persistence. A parsed envelope remains untrusted until the
shared project validator and current authorization checks accept it.

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

Run these commands from `apps/server/` so the scoped SDK pin applies:

```powershell
dotnet restore tests/Spatia.Server.Tests.csproj --locked-mode
dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore
dotnet format Spatia.Server/Spatia.Server.csproj --verify-no-changes --no-restore
dotnet format tests/Spatia.Server.Tests.csproj --verify-no-changes --no-restore
dotnet test --project tests/Spatia.Server.Tests.csproj -c Release --no-build --results-directory test-results -- --report-trx --minimum-expected-tests 1
```

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

No PostgreSQL, Identity/session/CSRF, complete domain-validation, hosted request-limit,
API restart or fresh-browser persistence checks have run. Those integrations remain
required for the parent persistence task.
