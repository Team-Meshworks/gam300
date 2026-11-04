# New Project form integration

`NewProjectForm` is a reusable frontend form. Supply `organizationName`, `creatorName`, `classes` and `students` from host-validated, authorized data. Each student includes the class IDs for which they are eligible. Key the form by identity and organization so a change of either remounts it instead of retaining the previous context's entries.

The types in `new-project-form.ts` describe UI data, not the backend wire format. The validated `NewProjectDraft` contains the entering device's local date and time. Convert it with `localDeadlineToUnixSeconds` for SCRUM-161 and display saved seconds with `formatLocalDeadline` in the viewer's local time. Nonexistent local times are rejected; for an ambiguous repeated time, the device's JavaScript date rules choose the instant. A request contains at most 20 selected students, and the server enforces authorization and roster eligibility.

Gallery sits beside Cover image and 360° in equally sized, 52px-high controls and opens the device's file chooser for an optional cover image. The draft may contain a local `coverImage` File; the preview does not upload or persist it. `imageType` accepts Cover image or 360°; Gallery is an action, not an image type. The cover preview releases its object URL when replaced, removed or unmounted. The 360° option remains unconnected. A host integrating storage must define the file upload and persistence contract separately.

`onSubmit` is optional. Without it, creation is unavailable and the create button is disabled. An integration returns one of these outcomes:

- `created` with the committed project ID: the form locks and calls `onCreated`, whose host owns opening that ID. Real navigation is still pending.
- `rejected` with a readable message: entries remain available for correction and retry. Return this only when creation is known not to have occurred.
- `unknown`: the form locks with the entries visible so the host can reconcile the outcome before allowing another creation. Thrown errors also produce this state.

While submission is pending, the form locks and warns on page unload. After success or an unknown outcome, it remains locked until the host reconciles and remounts it, preventing an accidental duplicate submission. An optional `onPreview` receives a validated draft; it does not create a project.

The optional `onCancel` callback lets the host leave the form and discard its draft. Without a callback, Cancel is disabled. The host owns navigation and must remount the form when discarding its state; cancellation is unavailable while the form is locked.

`../ui-preview/NewProjectExample.tsx` is a development-only simulation with unavailable, success, rejected and unknown scenarios. Changing the scenario or using Reset simulation intentionally remounts the keyed form and clears its entries. Cancel returns to the preview screen that opened New Project, or Classes for a direct entry, and discards the draft. It makes no server requests and creates no project.

`AssignmentCreationScreen` connects this form to SCRUM-161: it loads the current session, manageable source projects and classes, then loads enrolled students for the selected class. It submits the source revision, local deadline converted to Unix seconds, assignment details and selected students. Image controls are hidden because the assignment API does not persist those selections. The server remains authoritative for permissions, organization membership and revisions.

The screen stores an unconfirmed request in browser local storage under the current user ID before sending it. A browser Web Lock prevents two tabs for the same account from replacing that request. After a lost response, reopening the screen offers the exact same request ID and body for retry; only a confirmed result or a known first rejection clears it. The stored data includes the entered assignment text and student IDs. A browser that cannot provide storage or Web Locks cannot send a new assignment. Clearing browser storage while an outcome is unknown loses the retry identity; check existing assignments before creating another.

`AssignmentListScreen` reads the current account's visible assignments for a supplied class, and `AssignmentDetailsScreen` reads the selected assignment and displays its deadline in the viewer's local time. `/home` mounts these screens, supplies authorised class selection and teacher roster names, and remounts them when account identity changes. Student views show only the projects returned for their account. The host opens a selected project in the existing SCRUM-67 server editor and recovery coordinator. Production catalogue availability and live integrated acceptance still require verification.

`onNavigationStateChange` reports dirty and pending form state to the host. Leaving an unsent assignment or logging out requires an explicit discard choice; pending submissions block host navigation. Submitted requests remain under their original account's pending-request storage key and can be retried after a reload. The source selection is included in navigation protection. Account identity is rechecked after obtaining CSRF and before acknowledging a successful assignment.
An initial 403 or 404 is a definite rejection: the form remains editable and cancellable. A 403 or 404 after an earlier uncertain outcome does not resolve that outcome; the same pending request remains available for reconciliation.

Authorised assignment list and detail reads include `studentName` for each visible student project. The label uses display name and username when available, otherwise username. The API filters project visibility before returning names. For older responses without a name, a host-supplied authorised name may be used; otherwise the corresponding educator open control remains unavailable rather than presenting an ambiguous ordinal.

# Class assignment integration

`ClassAssignmentForm` receives host-authorized projects, classes and eligible students. Each project lists the class IDs available for that project; each student lists their eligible class IDs. Key the form by user and organization context so changes remount it. `ClassSelect` and `StudentSelector` are shared with New Project; changing the project or class clears the dependent selection and search.

`ClassAssignmentDraft` is UI data, not a backend wire contract. The host must map it to the eventual contract and enforce authorization and eligibility on the server. `onAssign` is optional; without it the button is disabled. Return `assigned` only after the complete assignment is confirmed, `rejected` only when no changes occurred, or `unknown` when the result is uncertain. Map partial results to `unknown` until a contract for them exists. `onAssigned` runs only after complete confirmation. Pending, success and unknown states lock the form; a known rejection preserves the selection for retry. Reconcile an unknown result before remounting and allowing another attempt.

The Classes preview uses fictional data and simulated outcomes. It makes no backend calls and does not provide roster management or create student drafts. The assignment card follows Figma node `232:19679`; its class picker and roster compose the existing New Project selector because that reference does not show a complete roster workflow.

# Submission and review integration

`SubmissionPanel` displays a host-supplied authorized submission snapshot for either a student or teacher. Key it by submission identity and revision, and remount after fetching a refreshed snapshot. `SubmissionDraft` includes identity, revision, action and feedback; these types are UI adapters, not an agreed HTTP contract. The server must enforce access, current revision and publication policy.

An optional `onAction` returns a confirmed snapshot, a known rejection or an unknown outcome. Confirmed results must match the requested identity, revision and expected state; a mismatch or thrown error becomes unknown. Pending actions lock controls, a rejection preserves feedback for retry, and unknown locks actions until the host reconciles and remounts. Publication remains disabled here. The preview uses independent student and teacher panels and simulated outcomes; it makes no real requests or saves.
