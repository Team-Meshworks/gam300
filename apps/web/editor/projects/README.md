# New Project form integration

`NewProjectForm` is a reusable frontend form. Supply `organizationName`, `creatorName`, `classes` and `students` from host-validated, authorized data. Each student includes the class IDs for which they are eligible. Key the form by identity and organization so a change of either remounts it instead of retaining the previous context's entries.

The types in `new-project-form.ts` describe UI data, not an agreed backend wire contract. The validated `NewProjectDraft` contains a calendar-date string (`YYYY-MM-DD`); do not infer a timezone or cutoff. Once the SCRUM-161 API contract exists, the host must map the draft to it and enforce authorization and roster eligibility on the server.

`onSubmit` is optional. Without it, creation is unavailable and the create button is disabled. An integration returns one of these outcomes:

- `created` with the committed project ID: the form locks and calls `onCreated`, whose host owns opening that ID. Real navigation is still pending.
- `rejected` with a readable message: entries remain available for correction and retry. Return this only when creation is known not to have occurred.
- `unknown`: the form locks with the entries visible so the host can reconcile the outcome before allowing another creation. Thrown errors also produce this state.

While submission is pending, the form locks and warns on page unload. After success or an unknown outcome, it remains locked until the host reconciles and remounts it, preventing an accidental duplicate submission. An optional `onPreview` receives a validated draft; it does not create a project.

`../ui-preview/NewProjectExample.tsx` is a development-only simulation with unavailable, success, rejected and unknown scenarios. Changing the scenario or using Reset simulation intentionally remounts the keyed form and clears its entries. It makes no server requests and creates no project.

# Class assignment integration

`ClassAssignmentForm` receives host-authorized projects, classes and eligible students. Each project lists the class IDs available for that project; each student lists their eligible class IDs. Key the form by user and organization context so changes remount it. `ClassSelect` and `StudentSelector` are shared with New Project; changing the project or class clears the dependent selection and search.

`ClassAssignmentDraft` is UI data, not a backend wire contract. The host must map it to the eventual contract and enforce authorization and eligibility on the server. `onAssign` is optional; without it the button is disabled. Return `assigned` only after the complete assignment is confirmed, `rejected` only when no changes occurred, or `unknown` when the result is uncertain. Map partial results to `unknown` until a contract for them exists. `onAssigned` runs only after complete confirmation. Pending, success and unknown states lock the form; a known rejection preserves the selection for retry. Reconcile an unknown result before remounting and allowing another attempt.

The Classes preview uses fictional data and simulated outcomes. It makes no backend calls and does not provide roster management or create student drafts. The assignment card follows Figma node `232:19679`; its class picker and roster compose the existing New Project selector because that reference does not show a complete roster workflow.
