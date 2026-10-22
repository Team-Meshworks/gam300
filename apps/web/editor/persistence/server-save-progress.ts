type SaveAttempt = Readonly<{
  clientMutationId: string;
  expectedRevision: number;
  editSequence: number;
}>;

type SaveAcknowledgement = Readonly<{
  projectId: string;
  clientMutationId: string;
  revision: number;
}>;

// One tracker per opened server project
// The session keeps the document and backup; this only tracks save confirmations
export function createServerSaveProgress(projectId: string, initialRevision: number) {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0)
    throw new Error("Invalid server revision");

  // Server revision changes only after a matching save reply
  // Edit counters stay local; several edits can be bundled into one server revision
  let revision = initialRevision;
  let editSequence = 0;
  let savedSequence = 0;
  let pending: SaveAttempt | null = null;

  return {
    edited() {
      editSequence += 1;
    },

    begin(clientMutationId: string): SaveAttempt | null {
      // Keep one outstanding save until its result is known
      // A failed connection may still have written the document on the server
      if (pending || editSequence === savedSequence) return null;
      if (revision === Number.MAX_SAFE_INTEGER) throw new Error("Server revision limit reached");
      pending = Object.freeze({ clientMutationId, expectedRevision: revision, editSequence });
      return pending;
    },

    acknowledge(receipt: SaveAcknowledgement): boolean {
      // Ignore replies from another project or a previous request
      // Retrying an accepted write returns the same revision as its first receipt
      if (
        !pending ||
        receipt.projectId !== projectId ||
        receipt.clientMutationId !== pending.clientMutationId ||
        receipt.revision !== pending.expectedRevision + 1
      )
        return false;

      revision = receipt.revision;
      // Edits made while saving stay dirty after this response arrives
      // Saving edit 4 while the editor reaches edit 6 leaves edits 5 and 6 unsaved
      savedSequence = pending.editSequence;
      pending = null;
      return true;
    },

    getSnapshot() {
      return {
        revision,
        dirty: editSequence !== savedSequence,
        // Retain this identity through uncertain failures
        // The caller must retry the same captured document with it
        pending,
      };
    },
  };
}
