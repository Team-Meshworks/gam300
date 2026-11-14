# Spatia state machines

Inventory for [SCRUM-180](https://meshworkss.atlassian.net/browse/SCRUM-180), based on source at `4925470` and subsequent fixes in this branch. Jira is authoritative for issue scope and status. A state can be an explicit enum, combination of fields, or persisted record. Tables describe implemented transitions; consult linked source for full guards. A failed response does not necessarily mean a write failed.

## Cross-cutting invariants

- The authored document is authoritative. Rendering, selection, camera and drag previews are session state. Validate project data before loading or saving, and preserve IDs through history and persistence. See [project validation](../apps/web/shared/project/project-validation.ts), [document store](../apps/web/editor/document-store.ts), and [architecture](architecture.md).
- A save cannot claim success without its matching receipt, overwrite newer work silently, or replace a conflict. An uncertain retry keeps the same identity and payload. The server rechecks authorization. See [autosave](../apps/web/editor/persistence/server-autosave.ts), [save progress](../apps/web/editor/persistence/server-save-progress.ts), and [save policy](../apps/server/Spatia.Server/Projects/ProjectSavePolicy.cs).
- Submissions, decisions and publications bind to project revisions. A later edit can make a submission or approval stale; the server enforces access and revision guards independently of UI controls. See [submissions](../apps/server/Spatia.Server/Reviews/ReviewSubmissionEndpoints.cs), [decisions](../apps/server/Spatia.Server/Reviews/ReviewDecisions.cs), and [publication coordinator](../apps/server/Spatia.Server/Publications/PublicationCoordinator.cs).
- Cleanup cancels or retires asynchronous work. Shared model resources stay alive until borrowers release their leases. See [model cache](../apps/web/shared/asset-runtime/ModelCache.ts) and [visitor canvas](../apps/web/visitor/ExhibitionCanvas.tsx).

## Identity, navigation and access

| State | Event and guard | Next state / effect |
| --- | --- | --- |
| Project entry checking | Session and project context resolved | Open the editable draft, facilitator view, or published view according to role and access |
| Checking | No session or forced password change | Prompt for sign-in before editing |
| Checking | Request fails | Error; retry checks again; cleanup suppresses stale result |
| Workspace loading | Session and role resolved | Available home, administration, review or editor route; denied/error otherwise |
| Active account/session | Disable, security-stamp change, forced password change, or hard expiry | Server rejects or restricts subsequent requests |
| Project active | Authorized manager archives | Archived: editing, publishing and assignment changes disallowed |
| Archived | Authorized manager restores | Active, subject to current grants and class membership |

Sources: [project entry](../apps/web/editor/reviews/FacilitatorProjectView.tsx), [workspace](../apps/web/editor/workspace/WorkspacePage.tsx), [account client](../apps/web/editor/accounts/account-client.ts), [server editor](../apps/web/editor/ServerProjectEditor.tsx), [account resolver](../apps/server/Spatia.Server/Security/CurrentAccountResolver.cs), [cookie events](../apps/server/Spatia.Server/Security/CurrentAccountCookieEvents.cs), [session service](../apps/server/Spatia.Server/Accounts/AccountSessionService.cs), and [project access](../apps/server/Spatia.Server/Projects/ProjectAccessService.cs). Dirty/pending editor work also constrains departure; see [departure choices](../apps/web/editor/ServerProjectEditor.tsx).

### Identity and administration details

`LoginPage` combines a nullable confirmed session with pending/error state: signed out, checking/signing in, forced password change, signed in and signing out are observable states. Busy and generation guards prevent concurrent writes and stale session checks. The form requires the new password to differ from the current password and match its confirmation. After the change, the client requires a confirmed session with `mustChangePassword` false. The client obtains CSRF before login, password change or logout; successful writes refresh CSRF and check session. Login requires a confirmed session; logout requires confirmed absence. Sources: [login](../apps/web/editor/entry/LoginPage.tsx), [account client](../apps/web/editor/accounts/account-client.ts).

| State | Event / guard | Transition and invariant |
| --- | --- | --- |
| Account enabled | Administrator disables | Disabled; security stamp changes and prior sessions lose authorization |
| Disabled | Authorized administrator enables | Enabled; authentication is still required |
| Organization active / inactive | Authorized administrator toggles | Organization eligibility checked on later requests; inactive is distinct from deleted |
| Organization present | Explicit administrator deletion with exact-name confirmation | Transaction purges dependent records and retires publication IDs; failed transaction rolls back |
| Forced change | Successful password change and session confirmation | Ordinary session; until then only restricted routes permitted |

Sources: [account session](../apps/server/Spatia.Server/Accounts/AccountSessionService.cs), [account resolver](../apps/server/Spatia.Server/Security/CurrentAccountResolver.cs), [directory](../apps/web/editor/directory/AccountDirectoryPage.tsx), [deletion dialog](../apps/web/editor/directory/DeleteOrganizationDialog.tsx), [organization deletion](../apps/server/Spatia.Server/Accounts/OrganizationDeletion.cs).

## Document, history and manipulation

| State | Event and guard | Next state / effect |
| --- | --- | --- |
| No project | Valid creation or validated open | Install document and initial history |
| Current document, history stacks | Accepted command changes snapshot | Push edit; clear redo; drop oldest past entry over limit |
| Same | Rejected, unchanged or throwing command | No history step; retain previous stacks |
| Can undo / redo | Successful revert / apply | Move entry between stacks; retain IDs and edit data |
| Drag idle | Start valid manipulation | Record before transform and preview outside document |
| Drag preview | Move | Update preview only |
| Drag preview | Release valid changed transform | Compare current object with before value, validate and commit one command including attached descendants |
| Drag preview | Cancel, mode change or stale/invalid transform | Cancel/restore preview; no command |
| Current selection | Object deleted or project/scene replaced | Reconcile session selection and controls with current document |

History recovery validates snapshots and limit; invalid history can be discarded while retaining the document. Sources: [command history](../apps/web/editor/command-history.ts), [transform command](../apps/web/editor/transform-command.ts), [recovery history](../apps/web/editor/recovery-history.ts), [app](../apps/web/editor/App.tsx), [renderer](../apps/web/editor/graphics/scene.ts), and [spatial validation](../apps/web/shared/project/spatial-validation.ts).

## Browser recovery, import and file export

| State | Event and guard | Next state / effect |
| --- | --- | --- |
| Account/project open | Committed edit | Queue a browser checkpoint with the document, undo history and server retry metadata |
| Checkpoint pending | IndexedDB transaction commits at the expected storage revision | Advance the storage revision |
| Checkpoint pending | Storage failure or stale expected revision | Preserve in-memory edits and the newer stored copy. Offer recovery or export on departure |
| Confirmed recovery | Dispose after the final checkpoint | Replace the payload with a strict `{revision, cleared: true}` marker |
| Cleared marker | Reopen, then save a new checkpoint | Open the server version without a recovery prompt and use the retained revision. The next write advances it and excludes stale writers |
| Recoverable document | Reopen with matching account and project | Offer stored changes or the server version. An older backup without retry metadata can be exported |
| Export chosen | Destination selected | Acquire the exclusive writer, compare the file to the captured baseline, write, and confirm on close. Abort the acquired stream on mismatch or failure |
| Download fallback or canceled export | No confirmed file write | Keep the editor open during a departure decision |
| Import chosen | Valid file and allowed account | Create a separate server project. A lost create response retains the uncertainty marker until reconciliation |

The signed-in editor reads and writes account/project keys in the version-2 database. The former standalone editor’s unscoped records stay untouched. File export, a browser checkpoint and a server receipt each confirm a different destination. See [server editor](../apps/web/editor/ServerProjectEditor.tsx), [recovery storage](../apps/web/editor/persistence/recovery-session.ts), [export writer](../apps/web/editor/persistence/project-files.ts) and [database schema](../apps/web/editor/persistence/draft-db.ts).

## Server autosave and recovery

| State | Event and guard | Next state / effect |
| --- | --- | --- |
| Saved | Document changes | Unsaved; increment local edit sequence and schedule |
| Unsaved | Flush valid document, revision available | Capture JSON, expected revision and mutation ID; persist recovery before send; saving |
| Saving | Further edit | Retain captured request; latest document stays dirty for a later save |
| Saving | Matching project, mutation and next-revision receipt | Advance confirmed revision and saved sequence; persist acknowledgement; saved if no newer edits, otherwise unsaved and schedule |
| Saving | Failure or unknown result | Failed; retain exact pending request for retry |
| Saving | Conflict / rejected | Pause; preserve edits and pending data for owner resolution, including during subsequent invalid/corrected edits |
| Saving | Definite 422 `invalid_document` | Clear uncommitted pending identity; persist current revision and latest edits; show invalid or schedule newer corrected work |
| Invalid | Correct document / manual flush | Mark unsaved and send a fresh mutation at the same revision, or retry explicitly |
| Failed | Manual save/reconnect | Retry pending identity/bytes, or retry local backup after confirmed write |
| Any | Dispose | Cancel timer/network; queue final local snapshot; old session cannot update new UI |
| Recovery | Valid baseline and pending request | Restore same pending identity/bytes; resume after account checks |

Server project writes take a row lock. Durable receipts permit an exact actor/mutation/digest/original-revision replay even after later writes, subject to current edit authorization; changed reuse conflicts. Recovery keeps request and latest scene separately and orders backup writes. Sources: [autosave](../apps/web/editor/persistence/server-autosave.ts), [progress](../apps/web/editor/persistence/server-save-progress.ts), [recovery validation](../apps/web/editor/persistence/server-save-recovery.ts), [draft write](../apps/web/editor/persistence/server-draft-write.ts), [server session](../apps/web/editor/persistence/server-project-session.ts), [save service](../apps/server/Spatia.Server/Projects/ProjectSaveService.cs), [writer](../apps/server/Spatia.Server/Projects/ProjectSaveWriter.cs), and [policy](../apps/server/Spatia.Server/Projects/ProjectSavePolicy.cs). Related issues: [SCRUM-66](https://meshworkss.atlassian.net/browse/SCRUM-66), [SCRUM-179](https://meshworkss.atlassian.net/browse/SCRUM-179).

## Camera, runtime and resources

| Machine / state | Event | Next state / invariant |
| --- | --- | --- |
| Editor first-person / third-person | Switch view | Engage walking or restore orbit camera and lens |
| Editor | Enter visitor preview | Save editor pose/lens, walk on floor, disable flight; authoring unavailable |
| Visitor preview | Change view | Remember choice; apply when leaving preview |
| Visitor preview | Exit | Restore editor pose/lens and appropriate control |
| Interaction timer | Scene starts, click or positive elapsed time | Run matching authored rules in order until a scene navigation is accepted; other actions continue dispatch; elapsed rules fire once per reset |
| Interaction timer | Reset / scene change | Reset elapsed/fired set and stop actions |
| Model absent | Acquire | Create shared in-flight load keyed by identity/version/URL/placement; each waiter owns a lease |
| Loading / loaded | Waiter aborts or releases | Decrement users once; cancel orphan load; dispose late parsed result |
| Loaded and idle | Last release | Retain briefly; evict on timeout or idle LRU cap |
| Any model | Invalidate | Remove lookup immediately; existing borrowers retain resource until last release |
| Viewport / visitor canvas loading | Ready, failure, retry or unmount | Present current attempt; abort/dispose obsolete work on cleanup |

Sources: [mode manager](../apps/web/editor/graphics/modeManager.ts), [FPS controls](../apps/web/editor/controls/fpsControls.ts), [interaction handler](../apps/web/editor/interaction/interactionHandler.ts), [navigation](../apps/web/editor/interaction/preview-navigation.ts), [action handler](../apps/web/editor/interaction/actionHandler.ts), [model cache](../apps/web/shared/asset-runtime/ModelCache.ts), [load queue](../apps/web/editor/graphics/model-load-queue.ts), [viewport](../apps/web/editor/viewport/Viewport.tsx), and [visitor canvas](../apps/web/visitor/ExhibitionCanvas.tsx).

### Asset placement and loading

The tested [asset library helper](../apps/web/editor/asset-library.ts) defines `closed`, `browsing`, `placing` but has no production caller. It is not the live picker. In that helper, open replaces the pending pick, choose captures the exact project, and placement requires the same project and finite coordinates. Case removal/attachment also checks the captured case and project; stale operations cancel; failed placement remains pending. Cancel creates no command. Live placement is owned by [App](../apps/web/editor/App.tsx)'s `placingAssetId` and [viewport](../apps/web/editor/viewport/Viewport.tsx), which supplies the placement result.

| Helper state | Event / guard | Next / effect |
| --- | --- | --- |
| `closed` / any | Open, optionally on existing case | `browsing`; replace prior pick, retain query; capture case/project when applicable |
| `browsing` | Choose current result with project | `placing` and captured project; case target instead commits attachment immediately if still current |
| `browsing` | Remove occupied captured case | Commit only if same project; close on success |
| `placing` | Finite position and unchanged project | Commit object; close on success; invalid position stays pending |
| `placing` or case browsing | Project changed | Cancel and reject stale operation |
| Any | Cancel | `closed`; no command |
[ModelLoadQueue](../apps/web/editor/graphics/model-load-queue.ts) retains a failed promise for the viewport lifetime. This is not a permanent retry failure: viewport retry increments the attempt and recreates the scene and its queue. Shared model leases and their independent cache lifecycle are described above.

## Projects, classes, review and publication

| Machine / state | Event and guard | Next state / effect |
| --- | --- | --- |
| Assignment absent | Authorized educator assigns active students | Transaction creates assignment, copied drafts, grants and provenance; exact ID/digest retry returns mappings |
| Creation / assignment form editing | Valid submit | Pending; double submission blocked |
| Pending | Confirmed / rejected / uncertain | Created or assigned / editing with error / unknown with input preserved and fresh action blocked |
| Submission adapter editing | Student completes then submits | Completed then submitted |
| Adapter submitted | Teacher saves review or approves | Submitted or approved; response must match identity, revision and expected state |
| Review ready | Prepare valid submission/decision | Confirm with immutable request identity and revision |
| Confirm | Send | Sending; matching receipt returns ready and reloads authoritative state |
| Sending | Unknown outcome | Unknown; retain input and intent for reconcile or exact retry |
| Unknown | Retry rejected / reconcile finds no match | Remain unknown; later denial does not prove first request failed |
| Server submission | New valid submission | Append immutable sequence bound to current revision; exact ID/digest replay returns result before new-state guards |
| Server decision | First / subsequent decision on current submission | Approve or return; approved can be approved, returned or revoked; returned/revoked terminal for that submission |
| Publish eligible | Valid current revision and approval, unique request | Snapshot new edition under project lock; matching replay returns existing result |
| Published edition | Hide/show, revoke, delete or audience change | Independent access fields change; revoke/delete permanent, deletion rejects later changes; archive independent |
| Visitor opening | Manifest/document validated | Display exhibition; focus/periodic recheck can withdraw access; retry restarts load |

Sources: [class assignment](../apps/server/Spatia.Server/Classes/ClassAssignmentCoordinator.cs), [classroom membership](../apps/server/Spatia.Server/Classes/ClassroomEndpoints.cs), [new project form](../apps/web/editor/projects/NewProjectForm.tsx), [assignment form](../apps/web/editor/projects/ClassAssignmentForm.tsx), [submission adapter](../apps/web/editor/projects/submission.ts), [submission panel](../apps/web/editor/projects/SubmissionPanel.tsx), [review UI](../apps/web/editor/reviews/ProjectReview.tsx), [submission endpoint](../apps/server/Spatia.Server/Reviews/ReviewSubmissionEndpoints.cs), [decisions](../apps/server/Spatia.Server/Reviews/ReviewDecisions.cs), [publication coordinator](../apps/server/Spatia.Server/Publications/PublicationCoordinator.cs), [delivery](../apps/server/Spatia.Server/Publications/PublicationDeliveryEndpoints.cs), [access state](../apps/server/Spatia.Server/Publications/PublicationAccessState.cs), and [visitor](../apps/web/visitor/main.tsx). Class membership and project access are rechecked under relevant locks; UI filtering is not the security boundary.

### Distinct UI write lifecycles

| Owner / explicit states | Transition and guard | Invariant |
| --- | --- | --- |
| [NewProjectForm](../apps/web/editor/projects/NewProjectForm.tsx): `editing`, `pending`, `created`, `unknown` | Valid submit → pending; confirmed → created; rejection → editing; uncertain → unknown | Fresh create blocked while outcome uncertain; input retained |
| [ClassAssignmentForm](../apps/web/editor/projects/ClassAssignmentForm.tsx): `editing`, `pending`, `assigned`, `unknown` | Valid selection → pending → assigned/rejected editing/unknown | In-flight guard blocks duplicate; selection retained on unknown |
| [ProjectCreation](../apps/web/editor/home/ProjectCreation.tsx): `ready`, `pending`, `unknown`, `created` | Persist uncertainty marker before POST; confirmed → created; rejected → ready; uncertain → unknown | Surviving marker requires checking projects before another create; no assumed idempotent replay |
| [ProjectGrantEditor](../apps/web/editor/home/ProjectGrantEditor.tsx): `loading`, `ready`, `pending`, `unknown`, `error` | Load → ready/error; save → pending → confirmed/rejected/unknown | Unknown requires reload; dirty choices require discard confirmation |
| [ProjectReview](../apps/web/editor/reviews/ProjectReview.tsx): `ready`, `confirm`, `sending`, `unknown` | Prepare stable intent → confirm → sending; receipt → ready/reload; uncertainty → unknown; reconcile or retry same intent | New intent blocked while unknown; later denial cannot prove original failure |
| [PublicationPage](../apps/web/editor/publications/PublicationPage.tsx): `ready`, `pending`, `unknown`, `success`, `stale`, `storage-error` | Confirm ready revision and persist request before sending; receipt → success; uncertainty → unknown; stale/storage failure blocks new publish | Retry preserves publication ID, revision and audience/viewers; storage key scopes account/project |
| [ProjectHome](../apps/web/editor/home/ProjectHome.tsx), [ClassHome](../apps/web/editor/home/ClassHome.tsx), [SubmissionPanel](../apps/web/editor/projects/SubmissionPanel.tsx): `ready`, `pending`, `unknown` | Action → pending → confirmed/rejected/unknown | Unknown requires authoritative refresh rather than guessing success |

### Persisted review and publication distinctions

A submission is an immutable sequence bound to a project revision. A later save makes the old submission stale: it cannot support a new decision or publication for the new revision. A new submission starts a new decision sequence. For a current latest submission, an initial decision can be approved or returned; approved can be approved, returned or revoked; returned and revoked are terminal for that submission. Exact matching submission/decision IDs and digests replay after current authorization, before new-state guards. See [submission endpoint](../apps/server/Spatia.Server/Reviews/ReviewSubmissionEndpoints.cs) and [decisions](../apps/server/Spatia.Server/Reviews/ReviewDecisions.cs).

A publication's immutable snapshot is separate from mutable `Audience`, `ViewerIds`, `Hidden`, `Revoked`, and `Deleted` access fields. These flags are independent: hidden can be shown, but show cannot undo revoked or deleted; deleted rejects later changes. Project archive is separate. New public/unlisted audience changes currently return unavailable; access checks eligibility at delivery. An exact publication ID/actor/digest replay is recognized after authority checks. Sources: [coordinator](../apps/server/Spatia.Server/Publications/PublicationCoordinator.cs), [access state](../apps/server/Spatia.Server/Publications/PublicationAccessState.cs), [delivery](../apps/server/Spatia.Server/Publications/PublicationDeliveryEndpoints.cs).

## Assets and supporting UI

| Machine / state | Event | Next state / effect |
| --- | --- | --- |
| Candidate upload | Validation | Pending or invalid, initially hidden |
| Pending, nondeleted | Authorized review | Approved and visible |
| Approved, nondeleted | Hide/show | Toggle hidden |
| Nondeleted | Delete | Deleted and hidden; immutable bytes/hash retained |
| Publication asset | Delivery | Requires approved and not removed from projects; hidden/deleted are separate retention semantics |
| List / dialog / form | Load or submit | Loading/pending, then data/success or error; retry and cancellation local to owner |
| Picker / menu / panel | Open, select, cancel or close | Local transient selection; authored changes pass through document commands |
| Audio preview | Choose/play/stop or unmount | UI playback and cleanup; does not itself modify document |
| Organization | Authorized confirmed deletion | Transaction purges dependent data and permanently retires publication IDs; failures roll back |

Sources: [asset administration service](../apps/server/Spatia.Server/Assets/AssetAdministrationService.cs), [asset administration UI](../apps/web/editor/asset-administration/AssetAdministration.tsx), [directory](../apps/web/editor/directory/AccountDirectoryPage.tsx), [dashboard](../apps/web/editor/admin/AdminDashboard.tsx), [project home](../apps/web/editor/home/ProjectHome.tsx), [publication page](../apps/web/editor/publications/PublicationPage.tsx), [bottom bar](../apps/web/editor/ui/BottomBar.tsx), [scene tree](../apps/web/editor/ui/SceneTreePanel.tsx), [content editor](../apps/web/editor/ui/ContentEditor.tsx), [display editor](../apps/web/editor/ui/DisplayEditor.tsx), [audio library](../apps/web/editor/ui/AudioLibrary.tsx), [settings](../apps/web/editor/ui/SettingsPanel.tsx), and [organization deletion](../apps/server/Spatia.Server/Accounts/OrganizationDeletion.cs). Equivalent local controls are grouped rather than treating every boolean as a separate product lifecycle.

## Confirmed invalid states and follow-up

| Priority / issue | Reachable invalid state and source trace | Fix and regression |
| --- | --- | --- |
| P1 local ranking — [SCRUM-183](https://meshworkss.atlassian.net/browse/SCRUM-183) | In Chrome 157 using production [writeProjectFile](../apps/web/editor/persistence/project-files.ts) and OPFS, first writer pauses before close; second compares the same original baseline and successfully commits; first closes last and overwrites the acknowledged second save. The stream used default `siloed` mode. | Acquire `createWritable({mode: "exclusive"})` before comparing baseline; abort the acquired stream on mismatch/failure. The red OPFS regression observed final text `first` after second was acknowledged. After the fix, the [server-autosave browser suite](../apps/web/tests/server-autosave.check.mjs) passed: the overlapping writer was rejected, first bytes remained, a stale baseline was rejected after close, and a valid follow-up succeeded after abort released the lock. This demonstrates overlapping browser writers on OPFS, not exclusion of arbitrary external OS writers. Chrome documents the default and exclusive modes in [multiple readers and writers](https://developer.chrome.com/blog/new-dev-trial-for-multiple-readers-and-writers/). Jira priority is High. |
| P1 local ranking — [SCRUM-182](https://meshworkss.atlassian.net/browse/SCRUM-182) | Tab A holds storage revision 1; cleanup deletes the record; tab B sees absence and writes newer offline work at revision 1; A then writes with expected revision 1 and overwrites B. The actual stale write succeeded in the [local-drafts regression](../apps/web/editor/persistence/local-drafts.test.ts) before the fix. Source: [recovery storage](../apps/web/editor/persistence/recovery-session.ts), [server editor](../apps/web/editor/ServerProjectEditor.tsx). | Replace cleared records with a strictly validated, payload-free `{revision, cleared: true}` marker retaining the existing revision; load it as empty recovery and pass its revision without a recovery prompt. A subsequent write increments it, so the stale writer conflicts. The red fake-database regression reported 1 failed, 42 skipped. After the fix, `node node_modules/vitest/vitest.mjs run editor/persistence/local-drafts.test.ts editor/persistence/server-autosave.test.ts editor/persistence/server-save-recovery.test.ts editor/edit-session.test.ts` passed: 4 files, 85 tests. The full server-autosave browser suite also passed using Chrome for Testing 157.0.8103.38 with real IndexedDB: captured revision 2, clearing retained 2, newer backup advanced to 3, and stale expected revision 2 was rejected while preserving the newer title. Jira priority is High. |
| P1 local ranking — [SCRUM-179](https://meshworkss.atlassian.net/browse/SCRUM-179) | A definite `422 invalid_document` left the captured request rejected and pending, so correcting the document could not produce a new save. Separately, a locally invalid blank-link draft changed a conflict/rejected status to failed; correction then changed it to unsaved, permitting a network retry despite the unresolved block. See [autosave](../apps/web/editor/persistence/server-autosave.ts), [draft write](../apps/web/editor/persistence/server-draft-write.ts), and [server save service](../apps/server/Spatia.Server/Projects/ProjectSaveService.cs). | Classify only `422` with problem code `invalid_document` as definitely uncommitted: durable receipt lookup precedes validation. Clear that request, preserve current revision and latest edits, and use a fresh mutation after correction; keep conflict and authorization/rejection states sticky. Other 400, 413 and 422 responses remain rejected. Before the fix, 5 tests failed and 29 passed in two files. Afterward, `node node_modules/vitest/vitest.mjs run editor/persistence/server-autosave.test.ts editor/persistence/server-draft-write.test.ts editor/persistence/server-save-progress.test.ts editor/persistence/server-save-recovery.test.ts editor/persistence/local-drafts.test.ts editor/edit-session.test.ts` passed: 6 files, 114 tests. The full server-autosave browser check passed in Chrome for Testing 157.0.8103.38 after one unchanged rerun of an existing capability-revocation timeout. Full issue acceptance remains open. Jira priority is Medium; the P1 label here ranks impact within this inventory. |
| P2 — [SCRUM-181](https://meshworkss.atlassian.net/browse/SCRUM-181) | Two scenes with elapsed-time navigation A → B → A repeatedly restart one another. `interactionHandler.update` called `beginEvent` for every elapsed batch, clearing the navigation visited set that must persist across automatic transitions. See [interaction handler](../apps/web/editor/interaction/interactionHandler.ts), [preview navigation](../apps/web/editor/interaction/preview-navigation.ts), and [app wiring](../apps/web/editor/App.tsx). | Preserve the automatic navigation chain for elapsed events; a deliberate click starts a new chain. The regression in [preview navigation tests](../apps/web/editor/interaction/preview-navigation.test.ts) failed before the fix: expected B after the second automatic transition, observed A. After the fix, `node node_modules/vitest/vitest.mjs run editor/interaction/preview-navigation.test.ts editor/interaction/interactionHandler.test.ts editor/interaction/actionHandler.test.ts` passed: 3 files, 23 tests. |

A theoretical interleaving alone is not proof of a reproduced product bug. Tables describe code paths and invariants; they do not claim every interleaving was exercised.


### State coverage matrix

| Source / representation | Inventory |
| --- | --- |
| [WorkspacePage](../apps/web/editor/workspace/WorkspacePage.tsx): `loading`, `error`, `ready`; [ProjectEntry](../apps/web/editor/reviews/FacilitatorProjectView.tsx) selects the authorized editor, review or published view; [LoginPage](../apps/web/editor/entry/LoginPage.tsx): session/pending | Identity and account sequencing |
| [asset-library](../apps/web/editor/asset-library.ts): `closed`, `browsing`, `placing` (tested helper, not production wired); [mode manager](../apps/web/editor/graphics/modeManager.ts): editor/visitor × first/third × capture | Placement and camera |
| [server autosave](../apps/web/editor/persistence/server-autosave.ts): `saved`, `unsaved`, `saving`, `failed`, `conflict`, `rejected`, `invalid`; [draft result](../apps/web/editor/persistence/server-draft-write.ts): `saved`, `conflict`, `rejected`, `failed`, `invalid` | Persistence and confirmed findings |
| [NewProjectForm](../apps/web/editor/projects/NewProjectForm.tsx), [ClassAssignmentForm](../apps/web/editor/projects/ClassAssignmentForm.tsx), [ProjectCreation](../apps/web/editor/home/ProjectCreation.tsx), [ProjectGrantEditor](../apps/web/editor/home/ProjectGrantEditor.tsx), [ProjectHome](../apps/web/editor/home/ProjectHome.tsx), [ClassHome](../apps/web/editor/home/ClassHome.tsx) | Distinct UI write lifecycles |
| [SubmissionPanel](../apps/web/editor/projects/SubmissionPanel.tsx), [ProjectReview](../apps/web/editor/reviews/ProjectReview.tsx), [PublicationPage](../apps/web/editor/publications/PublicationPage.tsx) | UI phases distinguished from persisted review/publication state |
| [App](../apps/web/editor/App.tsx), [scene](../apps/web/editor/graphics/scene.ts), [visitor](../apps/web/visitor/main.tsx), [canvas](../apps/web/visitor/ExhibitionCanvas.tsx), [ModelCache](../apps/web/shared/asset-runtime/ModelCache.ts) | Selection/drag, viewport attempt, access recheck and lease lifecycles |
| [AssetAdministration](../apps/web/editor/asset-administration/AssetAdministration.tsx), [AccountDirectoryPage](../apps/web/editor/directory/AccountDirectoryPage.tsx), [AdminDashboard](../apps/web/editor/admin/AdminDashboard.tsx), [AssignmentScreens](../apps/web/editor/projects/AssignmentScreens.tsx) | Request/confirmation and administration transitions; individual fields and modal booleans remain local presentation state |

### Needs validation: lock ordering

[OrganizationDeletion](../apps/server/Spatia.Server/Accounts/OrganizationDeletion.cs) locks organization projects in ID order and then classrooms. [ClassroomEndpoints](../apps/server/Spatia.Server/Classes/ClassroomEndpoints.cs) locks a classroom before affected projects; [ClassAssignmentCoordinator](../apps/server/Spatia.Server/Classes/ClassAssignmentCoordinator.cs) likewise locks a classroom before the source project. These opposite orders admit a possible database deadlock under concurrent operations. PostgreSQL selects a victim and rolls its transaction back; deletion handles `40P01`, whereas class operations do not. This source trace is a candidate, not a reproduced invalid durable state or assigned severity; validate with a controlled concurrency regression before filing it as a confirmed bug.

## Persistence and session ownership

The [save progress tracker](../apps/web/editor/persistence/server-save-progress.ts) owns each pending mutation, its original request bytes and revision, and the last confirmed document. [Autosave](../apps/web/editor/persistence/server-autosave.ts) schedules checkpoints and sends the captured request. The [server project session](../apps/web/editor/persistence/server-project-session.ts) captures the matching undo history before queuing a checkpoint. Only a committed transaction advances the account/project storage revision, including a final checkpoint after disposal.

[History validation](../apps/web/editor/recovery-history.ts) compares validated document contents across checkpoints, including after an undo upgrades a version-1 scene. [Recovery storage](../apps/web/editor/persistence/recovery-session.ts) validates account-scoped records, retains cleared revisions and reads the existing version-2 envelope. The [database opener](../apps/web/editor/persistence/draft-db.ts) owns the store name and schema. The signed-in editor and facilitator preview use the [asset reader](../apps/web/editor/persistence/server-assets.ts) directly. Standalone editing and local-file migration were retired on dev.

Four [save progress cases](../apps/web/editor/persistence/server-save-progress.test.ts) cover restored attempts with and without newer edits, definite rejection, and a mismatched server revision. A [held IndexedDB write](../apps/web/editor/persistence/local-drafts.test.ts) exercises two edits, undo during a pending departure, sequential storage revisions, and undo after reopening the second checkpoint.

## Verification

After merging dev at `1560743`, all 1,043 web unit tests across 111 files passed under Node 24.22.2. TypeScript, the editor and visitor production builds, and the architecture check passed (536 sources and 2,229 imports). The [hosted recovery checks](https://github.com/Team-Meshworks/gam300/actions/runs/43564671144/job/132355771006) passed against the signed-in editor, including real IndexedDB revisions, overlapping OPFS exports and save retries.

On the stacked ownership refactor, all 1,048 web unit tests across 111 files passed, including the five ownership cases above. Both production builds, TypeScript, the live import graph, and formatting of all 521 web files passed.

Before this integration, under pinned Node 24.22.2, checks passed: 87 Vitest files / 886 tests; `tsc -b`; oxlint; oxfmt (391 files); architecture (413 sources, 1,583 imports); editor build (252 modules); and visitor build (41 modules). The visitor build retained its existing >500 KB chunk warning. Local document links and `git diff --check` passed. Both full server-autosave and local-drafts browser suites passed under pinned Node 24.22.2 with Chrome for Testing 157.0.8103.38. One pinned autosave run timed out waiting for saved state after reopening following publication; a diagnostic rerun passed. An earlier capability-revocation timeout also passed on an unchanged rerun. Their causes are unconfirmed. Backend review is source-only; no live server or database concurrency tests were run.

## Coverage and limits

This inventory covers editor, workspace/account surfaces, project persistence, classroom/review/publication flows, visitor, runtime resources and server domain state represented by linked source. UI preview/demo fixtures, visual hover/focus values, build/deployment, external browser/network/storage internals and library-internal state are not separate product machines. Some independent booleans and form instances are grouped by lifecycle; consult source for field-specific guards. Source review is not an exhaustive proof of all asynchronous interleavings or external service behavior. Tests and dated evidence belong in their issue/progress records.
