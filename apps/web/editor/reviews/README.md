# SCRUM-165 review integration

The production /review workspace now loads authorized classes, assignments and saved
student projects through the existing API. Creator and Educator accounts can enter;
Administrator accounts do not gain review authority from directory access.

Students confirm the displayed server revision and submit it. Completion is a local
confirmation until the submission commits, matching the existing API. Educators
inspect retained submitted document data and save explicit approve, return or revoke
decisions with feedback. There is no feedback-only API operation. Feedback, late
status, submission history and stale approval are shown using server responses.

Writes use CSRF and stable submission/decision IDs. An unreadable or lost write
response locks further actions until the user checks the outcome or retries the same
intent. Cancellation before sending makes no request. Feedback is retained on
rejection, refresh failure and access loss; leaving with unsaved input warns the user.
API error text is mapped locally rather than displaying arbitrary server content.

## Integration boundaries

- The workspace uses existing server-saved projects. It does not upload local editor
  files or implement the SCRUM-67/126/127 server save/session handoff.
- Production submissions still require the SCRUM-164/73 approved retained-asset
  resolver. The default server registration returns review_assets_unavailable; the
  UI reports that failure and does not fabricate a successful submission.
- The retained document is available as read-only scene/object data. Protected 3D
  asset rendering remains unavailable pending the retained asset/delivery contract.
- SCRUM-70/85 and SCRUM-71 own publishing and protected delivery. Publication stays
  disabled here, even when review approval and CanPublish are present.
- This implementation does not complete SCRUM-165 end-to-end acceptance while
  these integration boundaries remain open.

## Verification

From apps/web:

    npm run test:unit -- editor/reviews/review-client.test.ts
    npm run test:reviews
    npm run typecheck
    npm run check:architecture
    npm run build:editor

The unit tests cover HTTP acknowledgement identity/revision checks, uncertain
retries, CSRF, asset-service rejection, pagination and stale approval. The standalone
browser test uses HTTP fixtures and covers the mounted student/educator workflow,
cancellation, preserved feedback, duplicate-safe retries, later revisions,
administrator denial and 390/768/1366-pixel layouts.

ReviewScreensIntegrationTests adds two real HTTPS/PostgreSQL browser scenarios to
the server suite: the default unavailable asset resolver, and the established
test-only asset resolver. The latter exercises submit, approve, student feedback,
a real later draft save, and retained historical content. It does not prove
production asset retention or protected byte delivery.

With the repository's disposable PostgreSQL test database configured, run from
apps/server:

    dotnet test --project tests/Spatia.Server.Tests.csproj -- --treenode-filter '/*/*/ReviewScreensIntegrationTests/*'

Local validation on 2 November 2026: 17 client/state tests and the HTTP-fixture browser
workflow passed. The server test project compiled with zero warnings/errors.
Real database scenarios were not run locally because SPATIA_TEST_DATABASE_CONNECTION
was not configured. The existing CI server suite discovers these tests.
