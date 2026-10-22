import { describe, expect, it } from "vitest";
import { createServerSaveProgress } from "./server-save-progress";

// Check which edits a receipt can clear without involving HTTP or browser storage
// Short request IDs make it easier to follow the order of replies here

describe("server save confirmations", () => {
  it("keeps edits made during a save dirty until their own confirmation", () => {
    const progress = createServerSaveProgress("project-a", 4);
    expect(progress.begin("unused")).toBeNull();
    progress.edited();
    expect(progress.begin("save-1")?.expectedRevision).toBe(4);
    // Another edit lands while save-1 is still waiting for its reply
    progress.edited();

    expect(
      progress.acknowledge({ projectId: "project-a", clientMutationId: "save-1", revision: 5 }),
    ).toBe(true);
    expect(progress.getSnapshot().dirty).toBe(true);
    expect(progress.begin("save-2")?.expectedRevision).toBe(5);
    expect(
      progress.acknowledge({ projectId: "project-a", clientMutationId: "save-2", revision: 6 }),
    ).toBe(true);
    expect(progress.getSnapshot()).toEqual({ revision: 6, dirty: false, pending: null });
  });

  it("retains the outstanding request when its result is uncertain", () => {
    const progress = createServerSaveProgress("project-a", 4);
    progress.edited();
    const attempt = progress.begin("save-1");
    progress.edited();

    // No acknowledgement after a lost connection
    // A newer edit must not replace the request that may already have reached the server
    expect(progress.begin("save-2")).toBeNull();
    expect(progress.getSnapshot().pending).toBe(attempt);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(progress.getSnapshot().dirty).toBe(true);
  });

  // Wrong project, old mutation or unexpected revision must leave the pending save alone
  it.each([
    { projectId: "project-b", clientMutationId: "save-1", revision: 5 },
    { projectId: "project-a", clientMutationId: "older-save", revision: 5 },
    { projectId: "project-a", clientMutationId: "save-1", revision: 4 },
    { projectId: "project-a", clientMutationId: "save-1", revision: 6 },
    { projectId: "project-a", clientMutationId: "save-1", revision: NaN },
  ])("ignores an unrelated or invalid receipt: %j", (receipt) => {
    const progress = createServerSaveProgress("project-a", 4);
    progress.edited();
    progress.begin("save-1");
    const before = progress.getSnapshot();
    expect(progress.acknowledge(receipt)).toBe(false);
    expect(progress.getSnapshot()).toEqual(before);
  });

  it("ignores a duplicate response while the next save is outstanding", () => {
    const progress = createServerSaveProgress("project-a", 4);
    const receipt = { projectId: "project-a", clientMutationId: "save-1", revision: 5 };
    progress.edited();
    progress.begin("save-1");
    progress.acknowledge(receipt);
    progress.edited();
    progress.begin("save-2");
    // Deliver save-1 again after save-2 has started
    // That duplicate must not clear save-2's unsaved state
    expect(progress.acknowledge(receipt)).toBe(false);
    expect(progress.getSnapshot().pending?.clientMutationId).toBe("save-2");
    expect(progress.getSnapshot().dirty).toBe(true);
  });

  it("keeps a previous session's response out of a newly opened project", () => {
    const progress = createServerSaveProgress("project-b", 0);
    expect(
      progress.acknowledge({ projectId: "project-a", clientMutationId: "save-1", revision: 5 }),
    ).toBe(false);
    expect(progress.getSnapshot()).toEqual({ revision: 0, dirty: false, pending: null });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid initial revision: %s",
    (revision) => {
      expect(() => createServerSaveProgress("project-a", revision)).toThrow(
        "Invalid server revision",
      );
    },
  );
});
