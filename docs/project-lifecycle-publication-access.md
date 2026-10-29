# Project lifecycle and publication access

This is the shared lifecycle handoff for
[SCRUM-69](https://meshworkss.atlassian.net/browse/SCRUM-69) and
[SCRUM-71](https://meshworkss.atlassian.net/browse/SCRUM-71). It records the existing
project APIs, one publication-access effects matrix, unresolved decisions and the
evidence needed for acceptance. It does not approve a new audience or retention
policy, or claim that publication, class or recovery integration is implemented.

**Review status:** awaiting joint SCRUM-69/SCRUM-71 review. The Jira descriptions
reviewed on 29 October 2026 require agreement, not an inferred policy. The existing
archive/reopen handoff below predates that review and still needs confirmation by
the publication-access owner. Record the decision and its review link in this
document when agreed; an unresolved row is not an accepted publishing default.

## Ownership and current implementation

- **SCRUM-69/84:** existing project creation, direct assignment authority,
  archive/reopen, current-account authorization and shared project locking. The
  implementation is on `dev` through [PR #22](https://github.com/Team-Meshworks/gam300/pull/22).
- **SCRUM-71:** the single audience/revocation policy, enforced on publication JSON,
  protected asset bytes and caches. SCRUM-69 supplies current lifecycle facts.
- **SCRUM-161:** class/roster/assignment metadata and independent student-draft
  mapping through the existing project foundation. **SCRUM-164:** private exact
  submitted revision evidence and the approval contract. These are not duplicate
  project or publishing systems.
- **SCRUM-70/85:** immutable publication creation; consume current authority,
  SCRUM-71 access policy, SCRUM-73 immutable assets and SCRUM-164 approval.
- **SCRUM-67/126:** client recovery and the home/account/project workflow, including
  save/export/cancel before switching. Their browser evidence is linked here when
  available; SCRUM-69 does not implement their UI.

The current [project model](../apps/server/Spatia.Server/Projects/Project.cs) and
[access snapshot](../apps/server/Spatia.Server/Projects/ProjectAccessSnapshot.cs)
contain project/organization IDs, archive state, revision and effective permissions.
They do **not** contain class-assignment provenance, submissions, approval or
publication state. `CanPublish` is existing draft authority; it is not proof of
class approval or permission to retrieve an existing publication. The integration
requirements below must not be mistaken for fields or services that already exist.

## Existing project API contract

All routes require a current full account. Writes also require CSRF validation;
lifecycle writes use the account-write limiter. Current server-owned membership
and assignments determine authority, not imported document fields, browser state
or supplied user/organization claims. The global Administrator has project
management authority; an Educator manages only assigned same-organization projects;
a Creator edits only assigned same-organization projects. An inaccessible ID and a
missing ID have the same public result.

| Route | Current behavior |
| --- | --- |
| `GET /api/projects` | Current authorized summaries; default limit 10, maximum 20; exclusive UUID cursor grants no authority. `archived=false` is the default; `true` selects archived projects. |
| `GET /api/projects/{id}` | `projectId`, validated current `document`, `revision`, `updatedAt` and effective `permissions`. This response has no `archived` field; list summaries include it. Authorized archived drafts remain readable. |
| `POST /api/projects` | Required title and exactly one approved `environmentAssetId` or validated `document`. Derives organization from current membership; an Administrator selects an active `orgId`. Commits a new ID, revision 0 and initial authority together; returns 201 metadata. |
| `POST /api/projects/{id}/duplicate` | Requires `expectedRevision`, title and edit authority on a nonarchived source. Produces an independent revision-0 document with a new project ID and preserved internal references. Does not change the source or copy its grants/retry metadata. Returns 201 metadata. |
| `PATCH /api/projects/{id}/assignments` | Requires `expectedRevision` and all three arrays: `managedByUserIds`, `assignedCreatorIds`, `canPublishUserIds`. Replaces the entire direct assignment set, including possible removal of the caller. Active same-organization Educators are managers; Creators are editors; creator publishers must be a subset of those editors. Requires management authority and a nonarchived project. Returns 200 metadata. |
| `PATCH /api/projects/{id}/archive` | Requires `expectedRevision` and `archived`. Management authority is required; either current archive state is allowed. Returns 200 metadata. |

Lifecycle metadata is exactly `{projectId, revision, updatedAt, archived}`. A
Creator's new project has edit authority only; an Educator's has edit/manage/publish
authority. Source assignments are not copied on duplication. Creation/import do
not confer class classification or approval. See
[the server request contract](../apps/server/README.md#scrum-6645-protected-save-and-project-lifecycle)
for title, array, document and request-size bounds.

Every successful assignment/archive request increments the common revision and
timestamp and clears the latest-save retry metadata, including a repeated request
for the same archive state. It preserves the authored document. A maximum-revision
project cannot accept another metadata revision but can be duplicated into a new
revision-0 project. Reopen computes permissions from current assignments; it does
not restore an old grant set.

Creation/duplication are not idempotent. After an uncertain response, refresh the
authorized list before offering another attempt; do not promise that this can
uniquely identify a prior request. After an uncertain metadata response, reopen
before deciding on another revisioned operation. A lost acknowledgement, session
cutoff or cancellation after commit can leave a durable change. PUT keeps its
separate latest-mutation retry contract. Never resolve uncertainty by blindly
overwriting the current revision.

### Error and recovery handoff

Responses are `no-store`. Errors contain fixed public problem fields and no
authored document or account details. Only an authorized revision conflict or
exhaustion includes `currentRevision`. Request binding, account policy and CSRF can
reject a request before its project handler runs.

| HTTP / code | Meaning and SCRUM-67/126 responsibility |
| --- | --- |
| 401 `authentication_required` | Session missing, invalid or expired. Preserve unsaved work under its original account/project key; require authentication before retry. |
| 403 `access_denied` | The account policy or current operation is not allowed. A forced-password account is rejected by the route policy with this code; a restriction discovered during the handler can instead return `password_change_required`. Do not retry unchanged authority. |
| 404 `project_not_found` | Missing or no longer accessible, including loss of assignment. Treat an already-open draft as unavailable; preserve/export its local unsaved work rather than clearing it. This result cannot establish reassignment as the specific cause. The current API does not expose a separate reassigned reason, avoiding an existence disclosure to arbitrary callers. |
| 403 `project_read_only` | An authorized draft is archived and the requested write is forbidden. Preserve unsaved work and offer the recovery workflow; do not retry autosave until current edit authority is restored. |
| 409 `revision_conflict` | Another save or metadata change won. Preserve unsaved work, fetch current authorized state and resolve explicitly; do not silently replace the newer document. |
| 409 `revision_exhausted` | No next revision is representable. Do not retry the same write; retain the draft for an authorized copy/export path. |
| 400 `invalid_request` / `invalid_project_input`, 422 `invalid_document` / `invalid_project_assignments` / `organization_unavailable` | Correct the rejected input or selection. No partial lifecycle update is committed. Responses do not echo private content. |
| 503 `project_unavailable` / `storage_unavailable`, or an uncertain transport outcome | Keep unsaved work. Re-read authorized state before deciding whether a lifecycle mutation needs another attempt; a missing acknowledgement is not proof of rollback. |

The existing Chromium API test switches accounts and checks list/open isolation.
It does not test switching with an unsaved editor. SCRUM-67/126 must demonstrate
save/export/cancel, stale or out-of-order responses, and account/project partitioning
without relabeling one user's unsaved content as another's.

## Shared publication-access effects matrix

**Implemented** below describes current draft behavior only. **Required** comes
from the linked Jira contracts and still needs consumer implementation/evidence.
**Existing handoff** is the archive/reopen policy previously recorded in the server
README; it has not yet been jointly accepted here. **Open Dn** identifies a decision
below. A publication's stored edition is immutable; lifecycle changes do not rewrite
its content, assets or private review history. Retention/deletion policy is separate.

Public and unlisted links permit anonymous access under SCRUM-71; unlisted means
anyone holding the link, not a private audience. Authenticated publications reject
anonymous and unrelated users. Every serving decision applies to JSON **and**
protected asset bytes, including direct URLs and cache paths.

| Event | Draft / new publication | Existing public or unlisted edition | Existing authenticated edition | Basis / unresolved work |
| --- | --- | --- | --- | --- |
| Create or duplicate an ordinary project | Implemented independent draft and fresh authority; no publication is created or copied. New publication must separately check `CanPublish`. | No new edition or link is created; source editions are unchanged. | Same; copied draft authority is not visitor authority. | Existing API; publisher implementation belongs to SCRUM-70/85. Class-origin copy/import rules are Open D6. |
| Save a newer draft revision | Implemented revision advance. Required: a class-assigned project needs submission/approval for that exact new revision. | Existing edition stays immutable; a later draft/review change alone does not replace or revoke it. | Same content invariant; current SCRUM-71 access policy still applies. | SCRUM-164 and SCRUM-70/85 integration required. |
| Replace direct assignments or change a class roster | Implemented direct assignment replacement advances revision and rechecks current authority. Required: a roster change must participate in the shared locking/revision contract; neither event may turn class work into unrestricted work or reuse approval for an older revision. | Edition content is unchanged. Whether existing links remain accessible after reassignment/roster change is Open D1. | Edition content is unchanged. Which current members retain/gain access is Open D2. | SCRUM-69/71 agree effects; SCRUM-161/164 provide class mapping and approval contracts. |
| Archive | Implemented: retain authorized draft reads and management; deny saves, duplicate, assignment changes and effective publishing permission. Metadata revision advances. | Existing handoff: deny retrieval, retain snapshot. | Existing handoff: deny retrieval, retain snapshot, including for administrators on the visitor delivery path. | Joint confirmation and enforcement on JSON/assets/cache paths pending, Open D3. Private management access is not visitor access. |
| Reopen | Implemented: advance revision and derive current permissions. Required: reopening does not resurrect approval for an older revision. | Existing handoff: remove only the archive restriction; independent revocation and audience policy still apply. | Same, with current authenticated audience checks. Reopening does not restore removed membership. | Open D3; no unconditional link reactivation. |
| Return, reject or revoke private review approval | Required: SCRUM-164 controls the current approval result; its return/revocation semantics are unresolved. Existing `CanPublish` never becomes an approval grant. | Existing editions are unchanged; any publication revocation is a separate SCRUM-71 action. | Same; private review evidence does not become publication data. | SCRUM-164 decision plus SCRUM-71 integration, Open D4. |
| Revoke publication access | Does not by itself grant or revoke draft management or change stored draft content. | Required: revoked links cannot keep fetching data contrary to the agreed policy. | Same, including unrelated and formerly permitted sessions. | SCRUM-71 owns authorization, response and cache enforcement; propagation/retention details Open D5. |
| Disable an account or remove current organization membership | Implemented: account authority is re-resolved; invalid sessions cannot use project APIs. It is not a project-row metadata revision. | Whether this affects editions previously published by that account is Open D1/D5, not implied by draft logout. | Required current-session/audience checks; membership-to-audience relationship is Open D2. | Account foundation SCRUM-68; publication lifecycle policy SCRUM-71. |

### Decisions requiring owner review

Do not implement an open choice as a silent allow rule or invent a permanent deny
policy. Keep the affected publication path unavailable until its owners agree and
implement the contract. This document does not disable existing direct-project APIs.

| Decision | Question to resolve | Owner / required input | Status |
| --- | --- | --- | --- |
| D1 | After reassignment, roster change or publisher disablement, do existing public/unlisted links remain available, suspend, or require explicit revocation? Which actor may change that policy? | SCRUM-69 + SCRUM-71, with partner input where needed | Open; no decision/evidence link yet |
| D2 | Is an authenticated audience evaluated from current assignment/roster membership, a publication-specific audience, or another agreed rule? How do removed/new members and administrators behave? Draft `CanManage` is not an automatic visitor grant. | SCRUM-71 + SCRUM-69; SCRUM-161 supplies roster facts | Open; no decision/evidence link yet |
| D3 | Confirm the existing archive-denies/reopen-removes-only-archive handoff across all audiences and direct asset/cache paths; specify how an in-flight retrieval relates to the archive commit. | SCRUM-69 + SCRUM-71 | Existing handoff recorded; joint acceptance pending |
| D4 | What are private review return/revocation semantics and races, and how does the publisher consume the resulting current-revision approval? Existing published editions remain immutable. | SCRUM-164; SCRUM-70/85 and SCRUM-69/71 consume it | Open; review-state implementation belongs to SCRUM-164 |
| D5 | What retention/deletion, cache and revocation propagation rules apply to snapshots/assets after archive, reassignment, account disablement and explicit revocation? Already downloaded bytes cannot be recalled. | SCRUM-71, SCRUM-73 and partner input; SCRUM-69 supplies events | Open; no retention duration or propagation deadline adopted |
| D6 | How is server-owned class provenance retained through roster removal, reassignment and duplication/import, and what transitions, if any, can remove it? A copy or missing roster row must not silently bypass the class review requirement. | SCRUM-161 + SCRUM-164 with SCRUM-69/71 and SCRUM-70/85 | Open; no client boolean, JSON field or absent mapping is accepted as approval evidence |

## Shared transaction and class-review integration

The existing [ProjectAccessService](../apps/server/Spatia.Server/Projects/ProjectAccessService.cs)
requires a caller-owned `ReadCommitted` transaction for `LockAsync`, locks the project
row with `FOR UPDATE`, then re-resolves session/account, assignment and archive state
after any wait. The caller retains the transaction through the authorized write and
commit, and disposes it on denial/cancellation. Reads use a coherent `RepeatableRead`
snapshot; an in-flight authorized read may finish on that snapshot, while the next
request observes changed assignment. These draft read semantics do not decide the
publication/cache cutoff in D3/D5.

The current lock purposes are `EditDraft`, `ManageAssignments` and
`ChangeArchiveState`; none is a complete publication-approval check. Future consumers
must not treat choosing a lock purpose, having `CanManage`, or acquiring the SQL row
lock alone as authorization to publish or review.

The agreed class contracts must preserve these requirements:

1. Obtain classification from authoritative server-owned class/assignment data,
   outside exported project JSON. SCRUM-161 owns that mapping; SCRUM-69 supplies the
   current project authority/lifecycle boundary. Do not implement an `isClassAssigned`
   client switch or default missing/unavailable classification to ordinary work.
2. Keep assignment/roster changes and affected project authority consistent under
   the same project lock. Where an operation affects multiple independent drafts,
   SCRUM-161 must define its transaction, lock ordering and bounded retry/partial
   failure contract; this document does not invent batch atomicity.
3. Preserve class provenance when a student/educator is removed or reassigned, and
   apply the agreed D6 copy/import rules. A zero-member roster, a new editor, a
   changed role or a `CanPublish` grant must not erase the class review requirement.
4. Recheck current authority, archive state, confirmed revision and the SCRUM-164
   approval result while retaining the shared transaction through publication
   commit. Approval for revision N is not authority for N+1, including revisioned
   metadata. Do not infer educator review authority from directory administration.
5. Keep the actual submitted revision and immutable asset references as private
   SCRUM-164 history. Preserve existing publication content; any serving restriction
   is evaluated separately by SCRUM-71. Do not expose a review document as a visitor
   publication or create a second publisher in SCRUM-69.

The controlled direct-assignment/archive races already establish these current API
outcomes when both requests start at the same revision:

- Save commits first: metadata loses with authorized `409 revision_conflict`;
  persisted content is the winning saved document.
- Reassignment removing the saving actor commits first: the waiting save returns
  `404 project_not_found`, without current revision/content disclosure.
- Archive commits first: the waiting save returns `403 project_read_only`.
- In either metadata-first case the saved document remains intact, the metadata
  revision advances once, and the stale save cannot overwrite it.

## Acceptance evidence and remaining integration

Baseline: `dev` at
[`29e81ff`](https://github.com/Team-Meshworks/gam300/commit/29e81ff763243a048fc73dd340a2cb7dbd1d34ce).
The [CI run for that commit](https://github.com/Team-Meshworks/gam300/actions/runs/40548270428)
passed 532 server tests, zero failed/skipped. This is historical evidence, not a new
test run for this documentation change. The existing server README retains the
26 October lifecycle and API/PostgreSQL restart verification record; its referenced
local restart artifact was not independently opened during this handoff review.

| SCRUM-69 acceptance criterion | Existing evidence | Remaining acceptance |
| --- | --- | --- |
| 1. Two students; direct IDs/lifecycle cannot bypass authority | [ProjectReadEndpointTests](../apps/server/tests/ProjectReadEndpointTests.cs): `ProjectReads_TwoStudentsSeeOnlyTheirAssignmentsDespiteForgedClaimsAndCrossOrganizationAssignment`; [ProjectLifecycleTests](../apps/server/tests/ProjectLifecycleTests.cs): `ProjectLifecycle_InvalidAssignmentsAndUnauthorizedIdsCannotChangeOrRevealProjects` | Class/roster integration must preserve this boundary when SCRUM-161 exists. |
| 2. Admin provisions and assigns/reassigns | `ProjectLifecycle_AdministratorProvisionsAndReassignsStudentsWithoutExposingOtherWork` uses real account and project routes | Link the SCRUM-126 home/admin workflow evidence. |
| 3. Independent copy, correct internal references | `ProjectLifecycle_ImportAndDuplicatePreserveReferencesButNeverCopyAuthorityOrMutableDrafts`, for both supported document versions | Class-origin duplication/import must follow agreed D6 when introduced. |
| 4. Archive/reopen and concurrent reassignment/save | `ProjectLifecycle_ArchiveReopenAndAssignmentsPreserveSavedContentAndInvalidateOldRetry`; `ProjectLifecycle_SaveAndMetadataRacesUseOneLockAndPreserveTheWinner`, both commit orders for assignment and archive; [ProjectAccessTests](../apps/server/tests/ProjectAccessTests.cs) recheck authority after lock waits | Joint publication-effects decisions and class/review/publish race evidence. |
| 5. Safe errors, no unauthorized changes, unsaved-work preservation | Lifecycle rollback/expiry/CSRF tests; [ProjectHttpResults](../apps/server/Spatia.Server/Projects/ProjectHttpResults.cs); `Browser_ProjectListOpenAndAccountSwitchUseCurrentSession` | SCRUM-67/126 browser evidence with an actual unsaved editor, including save/export/cancel and late responses. API-only browser checks do not establish this guarantee. |

Before closing the story, attach these integration results to the relevant issues
and this record:

- **SCRUM-69/71:** accepted D1-D3 decisions and applicable D5/D6 decisions, with review
  links; real PostgreSQL/API/browser coverage for anonymous, permitted,
  unrelated-student and administrator sessions across public/unlisted/authenticated
  editions, JSON, direct assets and cache paths. Exercise archive/reopen,
  reassignment, roster removal and explicit revocation, including in-flight requests.
- **SCRUM-161/164/70/85 with SCRUM-69:** class mapping survives restart and
  reassignment; neither direct assignment changes nor roster/copy/import operations
  bypass approval. Test metadata versus approval/publication in both lock orders,
  old approved revisions, removed educators/students and archived projects, with no
  partial decisions/publications or rewritten history. Record actual service/API
  contracts once implemented rather than citing this handoff as implementation.
- **SCRUM-67/126:** browser evidence that unsaved work remains associated with its
  original account/project through authentication loss, reassignment, archive,
  conflict and explicit switch/logout, including save/export/cancel outcomes.

The existing direct-project backend has no additional identified implementation gap
from this review. The story's full acceptance remains open on owner agreement and
the integrations above. A later concrete gap in SCRUM-69 authority/lifecycle must
be fixed here; missing class, review, publication-access or recovery systems remain
with their named owners. Do not close SCRUM-69 merely because this document merges.
