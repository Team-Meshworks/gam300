import type { ServerDraftRequest } from "./server-draft-write";
import type { ServerSaveRecovery } from "./server-save-recovery";

type SaveAttempt = Readonly<{
  clientMutationId: string;
  expectedRevision: number;
  editSequence: number;
  documentJson: string;
  request: ServerDraftRequest;
}>;

type SaveAcknowledgement = Readonly<{
  projectId: string;
  clientMutationId: string;
  revision: number;
}>;

// One tracker per opened server project
// The session keeps the latest document and backup; this owns each captured save
export function createServerSaveProgress(
  projectId: string,
  initialRevision: number,
  documentJson: string,
  recovery?: ServerSaveRecovery,
) {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0)
    throw new Error("Invalid server revision");
  if (recovery && recovery.revision !== initialRevision)
    throw new Error("Invalid server recovery state");

  // Server revision changes only after a matching save reply
  // Edit counters stay local; several edits can be bundled into one server revision
  let revision = initialRevision;
  let editSequence = 0;
  let savedSequence = 0;
  let pending: SaveAttempt | null = null;
  let confirmedJson = recovery?.confirmedJson ?? documentJson;

  function capture(clientMutationId: string, capturedJson: string): SaveAttempt {
    return Object.freeze({
      clientMutationId,
      expectedRevision: revision,
      editSequence,
      documentJson: capturedJson,
      // Preserve the captured text so reopening recreates the original request bytes.
      request: Object.freeze({
        projectId,
        body: `{"expectedRevision":${revision},"clientMutationId":${JSON.stringify(clientMutationId)},"document":${capturedJson}}`,
      }),
    });
  }

  if (recovery?.pending) {
    editSequence = 1;
    pending = capture(recovery.pending.clientMutationId, recovery.pending.documentJson);
    if (documentJson !== pending.documentJson) editSequence += 1;
  } else if (documentJson !== confirmedJson) editSequence = 1;

  return {
    edited() {
      editSequence += 1;
    },

    begin(clientMutationId: string, capturedJson: string): SaveAttempt | null {
      // Keep one outstanding save until its result is known
      // A failed connection may still have written the document on the server
      if (pending || editSequence === savedSequence) return null;
      if (revision === Number.MAX_SAFE_INTEGER) throw new Error("Server revision limit reached");
      pending = capture(clientMutationId, capturedJson);
      return pending;
    },

    acknowledge(receipt: SaveAcknowledgement): boolean {
      // UUID casing can differ between the authored JSON and the server receipt
      // Ignore replies from another project or a previous request
      // Retrying an accepted write returns the same revision as its first receipt
      if (
        !pending ||
        receipt.projectId.toLowerCase() !== projectId.toLowerCase() ||
        receipt.clientMutationId.toLowerCase() !== pending.clientMutationId.toLowerCase() ||
        receipt.revision !== pending.expectedRevision + 1
      )
        return false;

      revision = receipt.revision;
      // Edits made while saving stay dirty after this response arrives
      // Saving edit 4 while the editor reaches edit 6 leaves edits 5 and 6 unsaved
      savedSequence = pending.editSequence;
      confirmedJson = pending.documentJson;
      pending = null;
      return true;
    },

    // Only a definite validation rejection can retire a mutation without a receipt
    reject() {
      pending = null;
    },

    getSnapshot() {
      return {
        revision,
        dirty: editSequence !== savedSequence,
        // Retain this identity through uncertain failures
        // The caller retries this complete captured request
        pending,
      };
    },

    getRecovery(): ServerSaveRecovery {
      return Object.freeze({
        revision,
        confirmedJson,
        pending: pending
          ? Object.freeze({
              clientMutationId: pending.clientMutationId,
              documentJson: pending.documentJson,
            })
          : null,
      });
    },
  };
}
