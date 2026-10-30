# M2 workspace integration

The production `/home` route uses the existing account client and UI foundation. `/login`
links here after a verified sign-in or mandatory password change. Vite and the Caddy
entry route both serve it. It does not mount the local-only editor or its recovery store.

## Plan and blocker checks

1. Project home: session gating, authorised lists, search, duplicate and archive/reopen.
   Completed against the existing SCRUM-66/69 routes. Opening a server project and
   coordinating account/project changes with recovery still require SCRUM-67. A blank
   project also needs an approved environment catalogue; `ProjectDocumentService`
   currently accepts development sample assets only and rejects production assets.
2. Class/roster and SCRUM-162 assignment screens are mounted. The SCRUM-161 class,
   roster, eligibility and assignment contracts were checked before implementation.
   Class creation and membership changes use real API routes; authorised teachers and
   administrators can create assignments. Students receive only their authorised assignment
   lists and details. Editor opening remains unavailable while SCRUM-67 is missing.
3. Audited remaining SCRUM-126 administration needs and exercised the built frontend against
   the SCRUM-161 backend in an isolated PostgreSQL schema. The final visual check caught and
   fixed mobile header overflow with long account names and missing student names after a
   restored assignment retry. Each completed part is committed locally.

Figma was read through the browser on 30 October 2026, as requested: M2 page `137:59552`,
creator home `226:14714` and assignment form `450:4686` in file `z6zgUEbttr46IgQeHBISLu`.
The shared shell supplies the existing Figma landmark and ambient SVGs. Project imagery,
review state and published editions are not fabricated from the design's example data.
The API does not currently supply those fields. No Figma connector calls were used.

The available Git refs were checked. A fresh fetch required interactive GitHub authentication
and was stopped. New remote work may exist beyond the local refs. This branch starts from
`d186723` on `feature/scrum-162-assignment-api-integration`; SCRUM-161 remains a separate
backend branch. No shared branch is merged or pushed by this work.

The current Jira browser session requires sign-in, so the issue descriptions could not be
refreshed through Browser Use. The coverage below uses the scope already established in
the task and verifies it against the available code. It is not a fresh Jira status update.

## Acceptance coverage and remaining blockers

| Area                                          | Implemented here                                                                                                                                                                            | Remaining dependency                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SCRUM-126 authenticated home                  | Verified login entry, session revalidation, account-context remounting, authorised lists, search, loading/error/empty states and logout                                                     | None for these flows                                                                                                                                                     |
| SCRUM-126 project lifecycle                   | Duplicate, archive and reopen using current revisions and verified acknowledgements                                                                                                         | Blank creation needs an approved environment catalogue/selection contract (SCRUM-73); current assets are development-only                                                |
| SCRUM-126 project opening/account transitions | Unsent assignment details are guarded; pending sends block navigation; uncertain assignment requests remain recoverable                                                                     | SCRUM-67 must supply authenticated server-project loading and the shared save/export/cancel recovery coordinator before editor links can be enabled                      |
| SCRUM-126 minimal administration/access       | Teacher class creation, authorised roster reads, student enrolment and member removal                                                                                                       | Account provisioning selectors need authorised organisation/account reads; safe project-access editing also needs the current grant set and project organisation context |
| SCRUM-162 assignment creation                 | Existing source/revision, class, enrolled students, title, description, instructions and device-local due time; Unix-second transport; one draft per student; durable exact-request retries | Requires the separate SCRUM-161 backend branch in an integrated build; opening created drafts still needs SCRUM-67                                                       |
| SCRUM-162 assignment lists/details            | Mounted in `/home`, teacher/student views, device-local deadline display, authorised roster names including after retry recovery                                                            | Editor opening as above; image/360-degree controls stay hidden because the assignment API does not persist them                                                          |

`AccountAdministrationEndpoints` currently exposes provisioning writes without an authorised
organisation/account directory. `PATCH /api/projects/{id}/assignments` replaces the full grant
set, but project reads do not expose that set. Do not build replacement-grant forms using
empty defaults or ask users to guess account IDs. SCRUM-170 owns authorised directory
reads and SCRUM-171 owns directory screens; agree the current-grant read contract before
implementing those SCRUM-126 controls.
Administrators can create a class only in an organisation identified by an existing
authorised class until that directory is available.

SCRUM-126 and SCRUM-162 are not fully complete while these dependencies remain. Submission,
review, publishing, imported-file provenance and general account-directory screens were
not added to this change.

## Project behaviour

Lists follow server permissions and pagination; no authored document enters the home.
Lifecycle writes submit the displayed revision and fresh CSRF token, recheck the account
around token acquisition and verify the acknowledgement. An uncertain response never
automatically retries a mutation. The user must inspect the refreshed list before another
copy, because creation and duplication have no server idempotency key. Archived projects
can be reopened only when the server returns management permission.

The editor integration is deliberately unavailable: `local-drafts.ts` still uses the
shared `local` principal. Linking a server project to that editor would risk loading the
wrong draft. This branch does not implement SCRUM-67 or claim that requirement is complete.

Part 1 checks: production build and architecture check passed; six focused API tests passed.
The browser regression passed anonymous/forced-password gates, role controls, archive/reopen,
uncertain duplication, denied-list recovery, logout and layouts at 1440, 1024, 768 and 390px.
Browser API responses in this regression are contract fixtures, not a live backend.

Part 2 checks: 42 focused tests, production build and architecture check passed. The workspace
browser check covers class creation, enrolment/removal, denied roster refreshes, dirty-form
and logout protection, locking navigation while sending, lost-response recovery after reload
with the identical request/body, and a Singapore-entered deadline displayed in New York.
Assignment and student-detail layouts were checked at desktop and mobile widths. The
administrator class form can reuse an organisation identified by an existing authorised
class; selecting a new organisation awaits SCRUM-170's authorised directory reads.

## Combined verification

The full web unit suite passed (420 tests). Type checking, production build, changed-path
ESLint and the dependency graph check passed. The isolated architecture regression also
passed all 14 forbidden-import probes and all module-removal checks with the active source
unchanged. Existing login/entry, New Project, class assignment and UI foundation browser
checks passed; the foundation test's old date-only fixture now includes a time. Browser
tests use the installed Chromium version; the Figma source was inspected in the user's browser.

`tests/workspace-live.check.mjs` is the browser half of the disposable integration check.
It accepts the loopback HTTPS fixture URL and the fixture's synthetic account/project/class
identifiers as JSON arguments. It does not accept production credentials. The local harness
at the parent workspace's `.artifacts/scrum126-live/WorkspaceLive.csproj` links the existing
`HttpsApplicationFixture`, `PostgresAccountFixture`, clock and log fixtures from
`feature/scrum-164-submission-review` at `7b5926a` (which includes SCRUM-161). That harness
stays outside this frontend branch so no backend changes or temporary merges are included.

With the existing SDK, package cache, Node and Playwright browsers on the path, build this
frontend, set `SPATIA_TEST_DATABASE_CONNECTION` to the owned disposable loopback database,
and run `dotnet run --project WorkspaceLive.csproj` from that harness directory. The fixture
requires database `spatia_scrum45_test`, creates its own uniquely named schema, applies real
migrations and drops only that schema on disposal. The harness serves the production web
build and production API routes in Development to use the existing sample catalogue.

The real API/browser check passed login, project duplication/archive/reopen, class creation,
enrolment, assignment creation and reload/retry after a deliberately lost committed response.
Database checks found exactly one assignment and two independent student drafts. A student
received only their own project; requests for the other student's project and class roster
returned 404. No production catalogue, deployment or editor recovery flow was verified.
