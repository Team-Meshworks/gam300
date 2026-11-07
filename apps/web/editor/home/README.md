# M2 workspace integration

## Current project creation and opening

Creators and Administrators can create a project directly from home, optionally
selecting an approved environment. Empty creation remains available when there are
no approved environments or the catalogue is unavailable. Educator New Project
opens a full-page class assignment form that creates an empty source without an
environment selection. An empty project is a schema-v2 scene with
`environmentAssetId: null`; selecting an approved environment creates a legacy v1
room. Current active organisation authority is still required, and an Administrator
explicitly selects an active organisation.

If the asset catalogue is unavailable when opening a project, the editor uses its
fallback only when the saved project validates against an empty asset map. It warns
about the outage and preserves recovery. The current visitor/publisher rejects v2
until runtime support is available. This current behaviour supersedes the creation
availability claim in the historical 5 November integration note below.

## Login and publishing integration

The project home and review flow can open `/publish?projectId=<id>`; the editor
uses its existing departure coordinator before leaving for publication. A verified
login or mandatory password change can return to a validated local `/p/<id>`
visitor route. See [publishing](../publications/README.md) and the separate
[visitor application](../../visitor/README.md). These integrations do not remove
the production catalogue or broader acceptance limits below.

## Historical 5 November 2026 dev integration

PR #34 is integrated with `dev` at `e921576`, including the merged class screens.
The home and administration flows remain a bounded SCRUM-126 implementation, not
full story acceptance. SCRUM-69 remains in progress and formally blocks SCRUM-126;
SCRUM-73 still owns approved production assets and environments. New project
creation remains clearly unavailable until an approved environment is available.
The editor opens editable authorised projects; archived projects must first be reopened.
SCRUM-67's server recovery coordinator is now complete and is invoked on departure.

On the merged source, 774 web unit tests, typecheck, lint, formatting, static and
isolated architecture checks, and the production build passed. Secure Chrome fixture
checks covered the home, project access, class assignments, dashboard, UI foundation
and server recovery. Two real HTTPS browser/API tests passed with synthetic accounts,
an isolated PostgreSQL database and a Development fixture catalogue; they do not
establish production asset approval or full accessibility and story acceptance.
The workflow runs on pushes to `main`/`dev` or manual dispatch; it does not run
automatically for a feature-branch pull request.

The production `/home` route uses the existing account client and UI foundation. `/login`
links here after a verified sign-in or mandatory password change. Vite and the Caddy
entry route both serve it. Editable authorised server projects open through the existing
server editor and its account/project-scoped recovery coordinator.

## 4 November 2026 integration update

SCRUM-161 class APIs, SCRUM-67 server recovery, SCRUM-170 directory reads and the
current-grant API are on `dev`. This integration mounts assignment screens, opens
editable projects through the server editor, and uses active directory organisations
for administrator class creation. Read-only and archived projects remain unavailable
in the editable server editor. Session gates retain an unsent assignment only for the
same verified actor, organisation and role. Confirmed editor departure returns home.
The existing account directory provides provisioning and reset, and the home links to it.
Administrators who sign in normally land on the dashboard and can open the project
workspace from its prominent link, then use the same home and class navigation.
The current-grant read API and administrator project-access editor are connected.
The editor loads the complete current set and only submits a replacement when its
existing flags can be represented without silently losing or upgrading access.
Educators do not receive an organisation-wide account picker.

The production catalogue and approved assets remain SCRUM-73 dependencies. An isolated
Development-catalogue browser test exercised real API grant editing and an educator-to-
student assignment, editor save/reopen and outsider denial. Broader real-service,
recovery and accessibility acceptance remains open; these checks do not establish full
Jira acceptance. The
following plan, dependency table and dated audit reflect the earlier implementation
and are retained as historical evidence, not current dependency status.

## Historical plan and blocker checks (30–31 October 2026)

1. Project home: session gating, authorised lists, search, duplicate and archive/reopen.
   Completed against the existing SCRUM-66/69 routes. Opening a server project and
   coordinating account/project changes with recovery still require SCRUM-67. A blank
   project also needs an approved environment catalogue; `ProjectDocumentService`
   currently accepts development sample assets only and rejects production assets.
   Until a production catalogue is available, non-empty project lists, project reads,
   duplication and class-assignment creation also fail when stored documents are validated.
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

At the 31 October 2026 integration, GitHub reported `dev` at `29e81ff` and
`admin/student-screens` at `b216cfa`, 31 commits and 131 files ahead of `dev`. This branch
incorporates `feature/scrum-162-assignment-api-integration` and the shared frontend base;
both feature branches were local and unpublished at that check. SCRUM-161 is a separate backend
[draft PR](https://github.com/Team-Meshworks/gam300/pull/30). The frontend owner has been
asked to agree a review and landing plan for the shared prerequisites.

Jira at that audit lists SCRUM-126 and SCRUM-162 as To Do and assigned to Dalton. SCRUM-69
remains In Progress and formally blocks SCRUM-126, although its core lifecycle routes are
already on `dev`. SCRUM-67 recovery is In Progress; SCRUM-73 approved assets and SCRUM-170
directory operations are To Do. SCRUM-171 owns the separate directory screens.

## Acceptance coverage and remaining blockers

| Area                                          | Implemented here                                                                                                                                                                            | Remaining dependency                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SCRUM-126 authenticated home                  | Verified login entry, session revalidation, account-context remounting, authorised lists, search, loading/error/empty states and logout                                                     | Non-empty production project lists require an approved server catalogue (SCRUM-73)                                                                                       |
| SCRUM-126 project lifecycle                   | Duplicate, archive and reopen using current revisions and verified acknowledgements                                                                                                         | Blank creation needs an approved environment selection; production duplication needs an approved server catalogue (SCRUM-73)                                             |
| SCRUM-126 project opening/account transitions | Unsent assignment details are guarded; pending sends block navigation; uncertain assignment requests remain recoverable                                                                     | SCRUM-67 must supply authenticated server-project loading and the shared save/export/cancel recovery coordinator before editor links can be enabled                      |
| SCRUM-126 minimal administration/access       | Teacher class creation, authorised roster reads, student enrolment and member removal                                                                                                       | Account provisioning selectors need authorised organisation/account reads; safe project-access editing also needs the current grant set and project organisation context |
| SCRUM-162 assignment creation                 | Existing source/revision, class, enrolled students, title, description, instructions and device-local due time; Unix-second transport; one draft per student; durable exact-request retries | Requires SCRUM-161; production creation also needs the approved server catalogue (SCRUM-73); opening drafts still needs SCRUM-67                                         |
| SCRUM-162 assignment lists/details            | Mounted in `/home`, teacher/student views, device-local deadline display, authorised roster names including after retry recovery                                                            | Editor opening as above; image/360-degree controls stay hidden because the assignment API does not persist them                                                          |

`AccountAdministrationEndpoints` currently exposes provisioning writes without an authorised
organisation/account directory. `PATCH /api/v1/projects/{id}/assignments` replaces the full grant
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
