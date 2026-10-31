# Project lifecycle and publication access

This is the shared lifecycle handoff for
[SCRUM-69](https://meshworkss.atlassian.net/browse/SCRUM-69) and
[SCRUM-71](https://meshworkss.atlassian.net/browse/SCRUM-71). It records the existing
project APIs, one publication-access effects matrix, agreed policy, unresolved
decisions and the evidence needed for acceptance. It does not choose a retention
policy or claim that publication, class or recovery integration is implemented.

**Review status:** [Foo's SCRUM-71 feedback on 29 October 2026][foo-review] confirms
the archive/reopen rule. The subsequent [audience and management proposal][policy-proposal]
received [his acceptance from the SCRUM-71 side][policy-acceptance]. This is discussion
agreement, not a formal PR approval or implementation evidence. Public/unlisted link
continuity, retention, request cutoff and class provenance still need owner decisions;
SCRUM-69 acceptance remains open.

[foo-review]: https://github.com/Team-Meshworks/gam300/pull/26#issuecomment-6496535846
[policy-proposal]: https://github.com/Team-Meshworks/gam300/pull/26#issuecomment-6498679694
[policy-acceptance]: https://github.com/Team-Meshworks/gam300/pull/26#issuecomment-6498892793

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
- **[SCRUM-173](https://meshworkss.atlassian.net/browse/SCRUM-173) /
  [SCRUM-175](https://meshworkss.atlassian.net/browse/SCRUM-175):** deferred M3
  file-origin implementation and contract, including copies, imports and full-document
  saves. SCRUM-161 may complete its independent M2 class work without this policy.
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

### Criterion 5: recovery response

**Option A confirmed for recovery, 31 October 2026:** The user reports that Foo
replied, "Project unavailable is sufficient option A works for me", to one of
their PR comments. This confirms the generic unavailable response for SCRUM-67
recovery. The GitHub connector did not return the specific comment or permalink.

When an account that previously opened a project later receives
`project_not_found`, it can infer only that the project is missing or no longer
accessible. It cannot identify reassignment, removal of another grant or
membership, or a missing project as the cause. A locally remembered project ID
or earlier open is not server-verified authority. Authentication and request
validation can reject a request before project access is checked; archive and
revision results do not override current project-access checks.

- **A — retain generic unavailability (confirmed for recovery):** keep the
  existing indistinguishable 404 for missing and inaccessible projects. SCRUM-67
  can treat an open draft as unavailable and preserve or export unsaved work
  without asserting why access was lost. No new response is required for this
  choice. Jira criterion 5 lists reassignment, but this generic result does not
  establish it as the cause.
- **B — expose a specific access-change reason (not selected):** this would
  require server-verifiable prior authority and cause, with defined disclosure
  and expiry boundaries. A remembered ID, imported field or client assertion
  alone would be insufficient. This recovery choice does not require such a
  reason or grant read/write authority.

**Remaining acceptance:** the recovery choice does not establish the
end-to-end unsaved-work guarantee or complete SCRUM-69. SCRUM-66 remains a
formal blocker, and SCRUM-67/126 must supply linked browser evidence. The
separate publication-access and retention decisions are unaffected.

**Verification of the agreed response:**

1. Keep responses for an unrelated account's inaccessible and nonexistent
   projects indistinguishable, with no document or revision disclosure. Check
   forged IDs and unrelated accounts. Expired sessions must receive no project
   existence information; a prior account's locally remembered ID must not
   grant a different account information or access.
2. Cover a previously authorized editor whose assignment is removed: the
   response is generic unavailability, without content or revision disclosure.
   Reinstating access must still use current server authorization.
3. Preserve the existing authenticated archive, stale revision and session-loss
   distinctions. Exercise save versus reassignment/archive in both lock orders:
   a committed winner is preserved and a waiting save rechecks authority without
   revealing the current revision after access is lost.
4. Link SCRUM-67/126 browser evidence that the chosen outcome preserves unsaved
   work or offers recovery/export without moving it to another account or
   project. Those issues own the client workflow, not this handoff.

The existing [lifecycle tests](../apps/server/tests/ProjectLifecycleTests.cs)
cover reassignment and both save/metadata lock orders; the
[read tests](../apps/server/tests/ProjectReadEndpointTests.cs) compare inaccessible and
missing project responses. Reuse that evidence rather than duplicating it.
No reassignment-specific response is required by the confirmed recovery choice.

## Shared publication-access effects matrix

**Implemented** below describes current draft behavior only. **Required** comes
from the linked Jira contracts and still needs consumer implementation/evidence.
**Owner-confirmed** is the existing archive/reopen rule confirmed in [Foo's review][foo-review].
**Agreed in discussion** identifies the [audience and management scope][policy-proposal]
[accepted by SCRUM-71][policy-acceptance]. Both still need implementation and
delivery evidence. **Proposal** records feedback awaiting agreement by the relevant
owners. **Open Dn** identifies remaining decisions below. A publication's stored
edition is immutable; lifecycle changes do not rewrite its content, assets or private
review history. Retention and deletion mechanisms are separate.

Public and unlisted links permit anonymous access under SCRUM-71; unlisted means
anyone holding the link, not a private audience. Authenticated publications reject
anonymous and unrelated users. Every serving decision applies to JSON **and**
protected asset bytes, including direct URLs and cache paths.

| Event | Draft / new publication | Existing public or unlisted edition | Existing authenticated edition | Basis / unresolved work |
| --- | --- | --- | --- | --- |
| Create or duplicate an ordinary project | Implemented independent draft and fresh authority; no publication is created or copied. New publication must separately check `CanPublish`. | No new edition or link is created; source editions are unchanged. | Same; copied draft authority is not visitor authority. | Existing API; publisher implementation belongs to SCRUM-70/85. Copy/import and full-document-save origin rules are Open D6. |
| Save a newer draft revision | Implemented revision advance. Required: a class-assigned project needs submission/approval for that exact new revision; full-document origin handling is Open D6, including saves to ordinary drafts. | Existing edition stays immutable; a later draft/review change alone does not replace or revoke it. | Same content invariant; current SCRUM-71 access policy still applies. | SCRUM-164 and SCRUM-70/85 integration required. |
| Replace direct assignments or change a class roster | Implemented direct assignment replacement advances revision and rechecks current authority. Required: ordinary reassignment retains its existing behavior. A class-created draft stays with its original student: reject assignment to another student, and preserve the draft and server-owned mapping when the original student's grant or membership is removed or restored. Roster changes must participate in the shared locking/revision contract; neither event may bypass class review or reuse older approval. | Agreed in discussion: the publication and its publisher identity do not transfer to a newly assigned student. Public/unlisted link continuity remains a proposal, Open D1. | Agreed in discussion: loss of project permission removes permission-derived visitor access; an eligible named viewer may retain access. See the agreed scope below. | D1 continuity remains open; D2 scope agreed in discussion. SCRUM-161/164 mapping and approval contracts remain necessary. |
| Archive | Implemented: retain authorized draft reads and management; deny saves, duplicate, assignment changes and effective publishing permission. Metadata revision advances. | Owner-confirmed: deny retrieval, retain snapshot. | Owner-confirmed: deny retrieval, retain snapshot, including for administrators on the visitor delivery path. | Archive rule confirmed in Foo's review; request cutoff and JSON/assets/cache enforcement remain Open D3. Private management access is not visitor access. |
| Reopen | Implemented: advance revision and derive current permissions. Required: reopening does not resurrect approval for an older revision. | Owner-confirmed: remove only the archive restriction; independent revocation and audience policy still apply. | Same, with current authenticated audience checks. Reopening does not restore removed membership. | Rule confirmed in Foo's review; enforcement evidence remains outstanding. No unconditional link reactivation. |
| Return, reject or revoke private review approval | Required: SCRUM-164 controls the current approval result; its return/revocation semantics are unresolved. Existing `CanPublish` never becomes an approval grant. | Existing editions are unchanged; any publication revocation is a separate SCRUM-71 action. Foo supports this existing requirement. | Same; private review evidence does not become publication data. | SCRUM-164 still defines review-state transitions and races; current-revision approval remains required for a new class edition, Open D4. |
| Hide or restore a publication | Agreed in discussion: only current managers of the publication's project may hide or restore it; audience selection alone does not grant management powers. | Agreed in discussion: hide blocks visitor access while retaining the edition; restore clears only hide, not archive, revocation or deletion. | Same, with current audience checks. | Agreed scope below; implementation and propagation evidence remain open under D5. |
| Delete a publication | Agreed in discussion: only current managers of the publication's project may delete it; draft effects still need definition. | Agreed in discussion: permanently remove link access and preserve assets needed elsewhere. | Same. | Retention, backup restore mechanisms and propagation remain Open D5; the proposed 30-day period is not adopted. |
| Revoke publication access | Does not by itself grant or revoke draft management or change stored draft content. | Required: revoked links cannot keep fetching data contrary to the agreed policy. | Same, including administrators and formerly permitted sessions. | SCRUM-71 owns authorization, response and cache enforcement; propagation/retention details Open D5. |
| Disable an account or remove current organization membership | Implemented: account authority is re-resolved; invalid sessions cannot use project APIs. It is not a project-row metadata revision. | Proposal for publisher disablement: retain the original publication and public/unlisted access unless archived, hidden or revoked. Organization-membership removal was not separately resolved by the review. | Agreed in discussion: recheck current account, named-viewer eligibility and permission-derived access. | Public/unlisted continuity remains Open D1/D5; account foundation SCRUM-68 and access policy SCRUM-71. |

### Agreed authenticated audience and management scope

The following is the [proposal][policy-proposal] [accepted by SCRUM-71][policy-acceptance];
it is not yet implemented:

- The original publisher can select or change named viewers while holding current
  edit **and** publish permission on the project. Current project managers can also
  change the audience. Named viewers must be active full accounts in the project's
  organization, but need not be assigned to the project.
- The original publisher with those permissions and current project managers have
  implicit visitor access without being named. A manager is an Educator currently
  assigned to manage that same-organization project, or a global Administrator with
  current project-management authority. The global Administrator retains global
  authority and is exempt from the named-viewer organization limit; directory powers
  alone grant no publication access.
- Recheck current account, eligibility and authority on each request. Loss of project
  permission ends permission-derived access, though an eligible named viewer can retain
  access. Reassignment transfers neither the original publication nor publisher identity
  to a newly assigned student. Visitor access never grants draft editing.
- Only current project managers may hide, restore or delete publications of projects
  they manage; audience selection alone grants the student no such power. Hiding
  retains the edition; restore clears only hide and cannot override archive,
  revocation or deletion. Deletion permanently removes link access and preserves
  assets needed elsewhere.

Archive and revocation deny visitor access for everyone, including administrators.
Reopen removes only the archive restriction. Apply the same access decision to JSON,
direct asset bytes and cached responses; private management/review is separate from
visitor access. The in-flight cutoff and deletion/backup mechanisms remain open.

### Decisions requiring owner review

Do not implement an open choice as a silent allow rule or invent a permanent deny
policy. Keep the affected publication path unavailable until its owners agree and
implement the contract. This document does not disable existing direct-project APIs.

| Decision | Question to resolve | Owner / required input | Status |
| --- | --- | --- | --- |
| D1 | The publication and publisher identity do not transfer to a newly assigned student. Foo also proposes keeping existing public/unlisted links available through reassignment, roster changes and publisher disablement unless archived, hidden or revoked. Confirm link continuity and organization-membership removal effects. | SCRUM-69 + SCRUM-71, with partner input where needed | Non-transfer agreed in [discussion][policy-proposal] and [accepted][policy-acceptance]; link continuity remains a proposal |
| D2 | The audience selection, named-viewer eligibility and permission-derived visitor access scope are agreed as recorded above. Implement and verify current account, audience and project-authority checks without granting draft editing. | SCRUM-71 + SCRUM-69; SCRUM-161 supplies roster facts | Agreed in discussion; implementation and access evidence pending |
| D3 | The archive-denies/reopen-removes-only-archive rule is confirmed by SCRUM-71. Foo proposes allowing delivery already underway to finish and blocking new requests after the change. Define the authorization/delivery cutoff relative to commit, including direct assets and cache responses, and verify the race. | SCRUM-69 + SCRUM-71 | Archive/reopen rule owner-confirmed; in-flight cutoff remains a proposal and enforcement unverified |
| D4 | Foo supports keeping existing editions unchanged after return/revoked approval, with separate hide/revocation and current-revision approval for a new class edition. Define private review transitions, decision/publication races and the approval result consumed under the project lock. | SCRUM-164; SCRUM-70/85 and SCRUM-69/71 consume it | Existing publication invariants supported; review-state contract and implementation remain open |
| D5 | Current project-manager authority and hide/restore/delete access effects are agreed above. Define retention, the deletion and backup-restore mechanism that preserves permanent link denial, cache invalidation and propagation. Foo's suggested 30-day backup period requires agreement; already downloaded bytes cannot be recalled. | SCRUM-71, SCRUM-73 and partner input; SCRUM-94 verifies restore/retention; SCRUM-69 supplies events | Management/access scope agreed in discussion; retention, mechanism and propagation remain open |
| D6 | Foo proposes keeping class copies/imports subject to educator approval; ordinary independent projects need no educator approval but still require existing publishing permission. Define origin handling for server-side copies, imports and full-document replacement via the existing save PUT, including replacement of an already ordinary draft. Specify supported import paths, unknown or unverifiable origin and any allowed reclassification; client JSON alone cannot prove origin. The draft publisher defaults to unavailable while trusted classification or required approval integration is absent. | SCRUM-173/175 (M3), with SCRUM-161/164, SCRUM-69/71 and SCRUM-70/85 | Proposal awaiting class/review owner input; deferred origin contract remains open |

Foo cites Figma Hide/Delete controls as context; this record does not verify those
screens or add their implementation to SCRUM-69. SCRUM-94 must verify the chosen
deletion policy after restore; this document does not select a backup-retention
period or restoration mechanism.

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

Future class contracts must preserve these requirements:

1. Obtain classification from authoritative server-owned class/assignment data,
   outside exported project JSON. SCRUM-161 owns that mapping; SCRUM-69 supplies the
   current project authority/lifecycle boundary. Do not implement an `isClassAssigned`
   client switch or default missing/unavailable classification to ordinary work.
2. Keep assignment/roster changes and affected project authority consistent under
   the same project lock. Where an operation affects multiple independent drafts,
   SCRUM-161 must define its transaction, lock ordering and bounded retry/partial
   failure contract; this document does not invent batch atomicity.
3. Keep each class-created draft with its original student; reject assigning it to
   another student. Removing or restoring that student's grant or class membership
   preserves the draft and server-owned mapping. Ordinary reassignment keeps its
   existing behavior. Preserve class provenance when an educator is removed or
   reassigned, and apply D6 copy/import/full-save rules once agreed. A zero-member
   roster, a changed role or a `CanPublish` grant must not erase the class review
   requirement.
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
| 1. Two students; direct IDs/lifecycle cannot bypass authority | [ProjectReadEndpointTests](../apps/server/tests/ProjectReadEndpointTests.cs): `ProjectReads_TwoStudentsSeeOnlyTheirAssignmentsDespiteForgedClaimsAndCrossOrganizationAssignment`; [ProjectLifecycleTests](../apps/server/tests/ProjectLifecycleTests.cs): `ProjectLifecycle_InvalidAssignmentsAndUnauthorizedIdsCannotChangeOrRevealProjects` | Class/roster integration must reject assignment of a class-created draft to another student and preserve its draft and mapping across original-student grant or membership removal and restoration. |
| 2. Admin provisions and assigns/reassigns | `ProjectLifecycle_AdministratorProvisionsAndReassignsStudentsWithoutExposingOtherWork` uses real account and project routes | Link the SCRUM-126 home/admin workflow evidence. |
| 3. Independent copy, correct internal references | `ProjectLifecycle_ImportAndDuplicatePreserveReferencesButNeverCopyAuthorityOrMutableDrafts`, for both supported document versions | Copy/import origin handling remains deferred to SCRUM-173/175 under D6. |
| 4. Archive/reopen and concurrent reassignment/save | `ProjectLifecycle_ArchiveReopenAndAssignmentsPreserveSavedContentAndInvalidateOldRetry`; `ProjectLifecycle_SaveAndMetadataRacesUseOneLockAndPreserveTheWinner`, both commit orders for assignment and archive; [ProjectAccessTests](../apps/server/tests/ProjectAccessTests.cs) recheck authority after lock waits | Joint publication-effects decisions and class/review/publish race evidence. |
| 5. Safe errors, no unauthorized changes, unsaved-work preservation | Lifecycle rollback/expiry/CSRF tests; [ProjectHttpResults](../apps/server/Spatia.Server/Projects/ProjectHttpResults.cs); `Browser_ProjectListOpenAndAccountSwitchUseCurrentSession` | SCRUM-67/126 browser evidence with an actual unsaved editor, including save/export/cancel and late responses. API-only browser checks do not establish this guarantee. |

Before closing the story, attach these integration results to the relevant issues
and this record:

- **SCRUM-69/71:** joint decisions on D1 public/unlisted link continuity, the D3
  request cutoff and remaining D5/D6 questions, alongside the recorded archive,
  audience and management agreements; real PostgreSQL/API/browser coverage for
  anonymous, permitted, unrelated-student and administrator sessions across
  public/unlisted/authenticated editions, JSON, direct assets and cache paths.
  Exercise archive/reopen, reassignment, roster removal, hide/restore/delete and
  explicit revocation, including in-flight requests.
- **SCRUM-161/164/70/85 with SCRUM-69:** verify ordinary reassignment still works;
  reject assigning a class-created draft to a different student, and preserve the
  original draft and mapping through grant and membership removal/restoration and
  restart. Neither direct assignment nor roster changes may bypass approval. Test
  metadata versus approval/publication in both lock orders,
  old approved revisions, removed educators/students and archived projects, with no
  partial decisions/publications or rewritten history. Record actual service/API
  contracts once implemented rather than citing this handoff as implementation.
- **SCRUM-67/126:** browser evidence that unsaved work remains associated with its
  original account/project through authentication loss, reassignment, archive,
  conflict and explicit switch/logout, including save/export/cancel outcomes.

Separately, **SCRUM-173/175 with SCRUM-164/85** own the deferred M3 origin
contract and its implementation and evidence for copies, imports and full-document
PUT replacement, including an ordinary draft receiving unverified content. Verify
that the agreed review/publication policy cannot be bypassed. Keep the draft
publisher unavailable while trusted classification or required approval integration
is absent; the deferred M3 policy does not block SCRUM-161's independent M2 work.

The existing direct-project backend has no additional identified implementation gap
from this review. The story's full acceptance remains open on owner agreement and
the integrations above. A later concrete gap in SCRUM-69 authority/lifecycle must
be fixed here; missing class, review, publication-access or recovery systems remain
with their named owners. Do not close SCRUM-69 merely because this document merges.
