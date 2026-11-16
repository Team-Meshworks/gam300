import { describe, expect, it } from "vitest";
import { createServerSaveProgress } from "./server-save-progress";

const documentJson = "{}";

// Check which edits a receipt can clear without involving HTTP or browser storage
// Short request IDs make it easier to follow the order of replies here

describe("server save confirmations", () => {
  it("keeps edits made during a save dirty until their own confirmation", () => {
    const progress = createServerSaveProgress("project-a", 4, documentJson);
    expect(progress.begin("unused", documentJson)).toBeNull();
    progress.edited();
    expect(progress.begin("save-1", documentJson)?.expectedRevision).toBe(4);
    // Another edit lands while save-1 is still waiting for its reply
    progress.edited();

    expect(
      progress.acknowledge({ projectId: "project-a", clientMutationId: "save-1", revision: 5 }),
    ).toBe(true);
    expect(progress.getSnapshot().dirty).toBe(true);
    expect(progress.begin("save-2", documentJson)?.expectedRevision).toBe(5);
    expect(
      progress.acknowledge({ projectId: "project-a", clientMutationId: "save-2", revision: 6 }),
    ).toBe(true);
    expect(progress.getSnapshot()).toEqual({ revision: 6, dirty: false, pending: null });
  });

  it("retains the outstanding request when its result is uncertain", () => {
    const progress = createServerSaveProgress("project-a", 4, documentJson);
    progress.edited();
    const attempt = progress.begin("save-1", documentJson);
    progress.edited();

    // No acknowledgement after a lost connection
    // A newer edit must not replace the request that may already have reached the server
    expect(progress.begin("save-2", documentJson)).toBeNull();
    expect(progress.getSnapshot().pending).toBe(attempt);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(progress.getSnapshot().dirty).toBe(true);
  });

  it.each([false, true])("restores an exact request with newer edits: %s", (newerEdits) => {
    const capturedJson = '{\n  "title": "Captured"\n}';
    const progress = createServerSaveProgress("project-a", 4, documentJson);
    progress.edited();
    const attempt = progress.begin("save-1", capturedJson)!;
    const latestJson = newerEdits ? '{"title":"Later edit"}' : capturedJson;
    const reopened = createServerSaveProgress("project-a", 4, latestJson, progress.getRecovery());
    const restored = reopened.getSnapshot().pending!;

    expect(restored.request).toEqual(attempt.request);
    expect(restored.documentJson).toBe(capturedJson);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.request)).toBe(true);
    expect(reopened.begin("different-save", latestJson)).toBeNull();
    expect(
      reopened.acknowledge({ projectId: "project-a", clientMutationId: "save-1", revision: 5 }),
    ).toBe(true);
    expect(reopened.getSnapshot()).toEqual({ revision: 5, dirty: newerEdits, pending: null });
    expect(reopened.getRecovery()).toEqual({
      revision: 5,
      confirmedJson: capturedJson,
      pending: null,
    });
  });

  it("keeps the confirmed baseline when a definitely invalid attempt is retired", () => {
    const progress = createServerSaveProgress("project-a", 4, documentJson);
    progress.edited();
    progress.begin("invalid-save", '{"title":"Rejected"}');
    progress.reject();
    expect(progress.getRecovery()).toEqual({
      revision: 4,
      confirmedJson: documentJson,
      pending: null,
    });
    expect(progress.getSnapshot().dirty).toBe(true);
    expect(progress.begin("corrected-save", '{"title":"Corrected"}')).toMatchObject({
      expectedRevision: 4,
      clientMutationId: "corrected-save",
    });
  });

  it("rejects recovery from a different server revision", () => {
    expect(() =>
      createServerSaveProgress("project-a", 4, documentJson, {
        revision: 3,
        confirmedJson: documentJson,
        pending: null,
      }),
    ).toThrow("Invalid server recovery state");
  });

  // Wrong project, old mutation or unexpected revision must leave the pending save alone
  it.each([
    { projectId: "project-b", clientMutationId: "save-1", revision: 5 },
    { projectId: "project-a", clientMutationId: "older-save", revision: 5 },
    { projectId: "project-a", clientMutationId: "save-1", revision: 4 },
    { projectId: "project-a", clientMutationId: "save-1", revision: 6 },
    { projectId: "project-a", clientMutationId: "save-1", revision: NaN },
  ])("ignores an unrelated or invalid receipt: %j", (receipt) => {
    const progress = createServerSaveProgress("project-a", 4, documentJson);
    progress.edited();
    progress.begin("save-1", documentJson);
    const before = progress.getSnapshot();
    expect(progress.acknowledge(receipt)).toBe(false);
    expect(progress.getSnapshot()).toEqual(before);
  });

  it("ignores a duplicate response while the next save is outstanding", () => {
    const progress = createServerSaveProgress("project-a", 4, documentJson);
    const receipt = { projectId: "project-a", clientMutationId: "save-1", revision: 5 };
    progress.edited();
    progress.begin("save-1", documentJson);
    progress.acknowledge(receipt);
    progress.edited();
    progress.begin("save-2", documentJson);
    // Deliver save-1 again after save-2 has started
    // That duplicate must not clear save-2's unsaved state
    expect(progress.acknowledge(receipt)).toBe(false);
    expect(progress.getSnapshot().pending?.clientMutationId).toBe("save-2");
    expect(progress.getSnapshot().dirty).toBe(true);
  });

  it("keeps a previous session's response out of a newly opened project", () => {
    const progress = createServerSaveProgress("project-b", 0, documentJson);
    expect(
      progress.acknowledge({ projectId: "project-a", clientMutationId: "save-1", revision: 5 }),
    ).toBe(false);
    expect(progress.getSnapshot()).toEqual({ revision: 0, dirty: false, pending: null });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid initial revision: %s",
    (revision) => {
      expect(() => createServerSaveProgress("project-a", revision, documentJson)).toThrow(
        "Invalid server revision",
      );
    },
  );
});

// The API emits lowercase UUIDs even when imported project JSON used uppercase
it("matches save identities independently of UUID casing", () => {
  // Capture an edit and mutation using the exact spelling from the opened document
  const progress = createServerSaveProgress(
    "ABCDEFAB-1234-4000-8000-123456789ABC",
    7,
    documentJson,
  );
  progress.edited();
  progress.begin("ABCDEFAB-1234-4000-8000-123456789DEF", documentJson);
  // The same IDs returned in lowercase must confirm the pending revision
  expect(
    progress.acknowledge({
      projectId: "abcdefab-1234-4000-8000-123456789abc",
      clientMutationId: "abcdefab-1234-4000-8000-123456789def",
      revision: 8,
    }),
  ).toBe(true);
  expect(progress.getSnapshot().dirty).toBe(false);
});
