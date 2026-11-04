import { expect, it } from "vitest";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { validateServerSaveRecovery } from "./server-save-recovery";

const assetKinds = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
// Whitespace matters here; a retry must retain the original request's document bytes
const documentJson = JSON.stringify(fixture, null, 2);
const pending = { clientMutationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", documentJson };
const recovery = { revision: 3, confirmedJson: documentJson, pending };
const validate = (raw: unknown) => validateServerSaveRecovery(raw, fixture.projectId, assetKinds);

it("keeps pending bytes unchanged and accepts a confirmed copy with no pending request", () => {
  expect(validate(recovery)).toMatchObject({ ok: true, value: { pending } });
  expect(validate({ ...recovery, pending: null })).toMatchObject({
    ok: true,
    value: { pending: null },
  });
});

// Check the recovery envelope separately from the existing project-schema tests
it.each([
  null,
  { ...recovery, extra: true },
  { ...recovery, revision: -1 },
  { ...recovery, revision: Number.MAX_SAFE_INTEGER },
  { ...recovery, pending: { ...pending, extra: true } },
  { ...recovery, pending: { ...pending, clientMutationId: "invalid" } },
  { ...recovery, pending: { ...pending, documentJson: "{}" } },
  { ...recovery, confirmedJson: "{}" },
])("rejects unusable recovery metadata", (raw) => {
  expect(validate(raw).ok).toBe(false);
});

it("rejects another project's confirmed copy or pending request", () => {
  const other = JSON.stringify({ ...fixture, projectId: pending.clientMutationId });
  expect(validate({ ...recovery, confirmedJson: other }).ok).toBe(false);
  expect(validate({ ...recovery, pending: { ...pending, documentJson: other } }).ok).toBe(false);
});
