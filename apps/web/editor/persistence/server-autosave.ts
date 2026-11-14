import type { ProjectDocument } from "../../shared/project/project-types";
import { serializeProject } from "../../shared/project/project-serialization";
import { createServerSaveProgress } from "./server-save-progress";
import { createServerSaveTimer } from "./server-save-timer";
import { validateServerSaveRecovery, type ServerSaveRecovery } from "./server-save-recovery";
import {
  writeServerDraft,
  type ServerDraftRequest,
  type ServerDraftResult,
} from "./server-draft-write";

export type ServerSaveStatus =
  | "saved"
  | "unsaved"
  | "saving"
  | "failed"
  | "conflict"
  | "rejected"
  | "invalid";

// Create after opening a confirmed server document
// Dispose before changing account/project; the existing session still owns local recovery
export function createServerAutosave(options: {
  document: ProjectDocument;
  revision: number;
  assetKinds: ReadonlyMap<string, string>;
  onStatus: (status: ServerSaveStatus) => void;
  write?: (request: ServerDraftRequest, signal: AbortSignal) => Promise<ServerDraftResult>;
  recovery?: ServerSaveRecovery;
  // Resolve only after IndexedDB commits the scene and pending request together
  backup?: (documentJson: string, serverSave: ServerSaveRecovery) => Promise<boolean>;
}) {
  const initial = serializeProject(options.document, options.assetKinds, { allowDraftLinks: true });
  if (!initial.ok) throw new Error(initial.error.message);
  const projectId = options.document.projectId;
  const progress = createServerSaveProgress(projectId, options.revision);
  const write = options.write ?? writeServerDraft;
  // Latest scene keeps changing as the student edits
  // Confirmed JSON stays at the last server acknowledgement
  // Pending JSON holds the particular scene already queued for sending
  let latestJson = initial.value;
  let latestDocument = options.document;
  let invalidDraft = !serializeProject(latestDocument, options.assetKinds).ok;
  let confirmedJson = initial.value;
  let pending: ServerSaveRecovery["pending"] = null;
  let request: ServerDraftRequest | null = null;
  let status: ServerSaveStatus = "saved";
  let running = false;
  let activeSave: Promise<void> | undefined;
  let disposed = false;
  const cancellation = new AbortController();
  let backupQueue = Promise.resolve(true);
  const saveTimer = createServerSaveTimer(() => {
    // Local recovery keeps running while network saves are paused
    if (running || ["failed", "conflict", "rejected", "invalid"].includes(status)) {
      void backup().then((ok) => {
        if (!ok && !disposed && status !== "conflict" && status !== "rejected") report("failed");
      });
    } else void flush();
  });

  function captureRequest(): ServerDraftRequest {
    if (!pending) throw new Error("No pending save");
    // Reopening must produce the same body as the interrupted request
    // Keep the stored document text untouched inside this envelope
    return Object.freeze({
      projectId,
      body: `{"expectedRevision":${progress.getSnapshot().revision},"clientMutationId":${JSON.stringify(pending.clientMutationId)},"document":${pending.documentJson}}`,
    });
  }

  if (options.recovery) {
    const restored = validateServerSaveRecovery(options.recovery, projectId, options.assetKinds);
    if (!restored.ok || restored.value.revision !== options.revision)
      throw new Error("Invalid server recovery state");
    confirmedJson = restored.value.confirmedJson;
    pending = restored.value.pending;
    if (pending) {
      // Rebuild the original attempt before counting edits made after it
      // A lost response may have committed this exact mutation already
      progress.edited();
      progress.begin(pending.clientMutationId);
      request = captureRequest();
      // Offline edits made after that request still need their own later save
      if (latestJson !== pending.documentJson) progress.edited();
    } else if (latestJson !== confirmedJson) progress.edited();
    status = progress.getSnapshot().dirty ? "unsaved" : "saved";
  }

  function backup(finalSnapshot = false) {
    const documentJson = latestJson;
    const serverSave = Object.freeze({
      revision: progress.getSnapshot().revision,
      confirmedJson,
      pending,
    });
    // Queue writes so a slow older snapshot cannot land after a newer one
    // Capture the strings now; edits can continue while storage is busy
    backupQueue = backupQueue.then(async () => {
      if (disposed && !finalSnapshot) return false;
      try {
        return (await options.backup?.(documentJson, serverSave)) ?? true;
      } catch {
        return false;
      }
    });
    return backupQueue;
  }

  function report(next: ServerSaveStatus) {
    status = next;
    options.onStatus(next);
  }

  function schedule() {
    if (!disposed) saveTimer.schedule();
  }

  // Manual Save joins an outstanding request instead of returning before its receipt
  function flush(): Promise<void> {
    if (activeSave) {
      return activeSave;
    }
    activeSave = send().finally(() => {
      activeSave = undefined;
    });
    return activeSave;
  }

  async function send() {
    // Reconnect and manual Save can arrive while a request is already running
    // Let that request finish before deciding which revision to send next
    if (disposed || running || status === "conflict" || status === "rejected") return;
    saveTimer.cancel();
    running = true;
    // An unfinished newer edit must not block a retry of already captured valid bytes.
    if (invalidDraft && !request) {
      const backedUp = await backup();
      running = false;
      if (disposed) return;
      report(backedUp && !invalidDraft ? "unsaved" : "failed");
      if (status === "unsaved") schedule();
      return;
    }
    if (!request) {
      if (
        progress.getSnapshot().dirty &&
        progress.getSnapshot().revision === Number.MAX_SAFE_INTEGER
      ) {
        await backup();
        running = false;
        if (!disposed) report("rejected");
        return;
      }
      const attempt = progress.begin(crypto.randomUUID());
      if (!attempt) {
        // A previous server save may have succeeded while its local backup failed
        // Retry the backup here without sending the same confirmed scene again
        const backedUp = await backup();
        running = false;
        if (!disposed) {
          report(backedUp ? (progress.getSnapshot().dirty ? "unsaved" : "saved") : "failed");
          if (progress.getSnapshot().dirty) schedule();
        }
        return;
      }
      // Store the exact document bytes with this mutation
      // Later edits replace latestJson, leaving retries tied to their original snapshot
      pending = Object.freeze({
        clientMutationId: attempt.clientMutationId,
        documentJson: latestJson,
      });
      request = captureRequest();
    }
    report("saving");
    // Never send a mutation whose retry identity would disappear on a crash
    // Storage failure leaves the request in memory for an explicit retry
    if (!(await backup()) || disposed) {
      running = false;
      if (!disposed) report("failed");
      return;
    }
    let result: ServerDraftResult;
    try {
      result = await write(request, cancellation.signal);
    } catch {
      result = { kind: "failed" };
    }
    // Cancellation may happen after the server committed
    // An old session must never update the new editor's status
    if (disposed) {
      running = false;
      return;
    }
    if (result.kind === "saved" && progress.acknowledge(result.receipt)) {
      // A matching receipt can only belong to the pending snapshot above
      if (pending) confirmedJson = pending.documentJson;
      pending = null;
      request = null;
      // Store the acknowledgement so recovery knows which request has finished
      const backedUp = await backup();
      running = false;
      if (disposed) return;
      report(
        backedUp && !invalidDraft ? (progress.getSnapshot().dirty ? "unsaved" : "saved") : "failed",
      );
      if (progress.getSnapshot().dirty) schedule();
    } else if (result.kind === "invalid") {
      const rejectedJson = pending?.documentJson;
      progress.reject();
      pending = null;
      request = null;
      const backedUp = await backup();
      running = false;
      if (disposed) return;
      report(
        !backedUp ? "failed" : invalidDraft || latestJson === rejectedJson ? "invalid" : "unsaved",
      );
      if (status === "unsaved") schedule();
    } else {
      running = false;
      // Conflict resolution requires an explicit reload/choice in the owning session
      // Keep both the active edits and the request; no silent revision replacement
      report(result.kind === "saved" ? "failed" : result.kind);
    }
  }

  return {
    changed(document: ProjectDocument): boolean {
      if (disposed || document.projectId !== projectId) return false;
      const encoded = serializeProject(document, options.assetKinds, { allowDraftLinks: true });
      if (!encoded.ok) return false;
      // Store notifications can happen without changing the authored scene
      // Avoid starting another save timer for the same document
      if (encoded.value === latestJson) return true;
      latestJson = encoded.value;
      latestDocument = document;
      const wasInvalid = invalidDraft;
      invalidDraft = !serializeProject(document, options.assetKinds).ok;
      progress.edited();
      if (status !== "conflict" && status !== "rejected") {
        if (invalidDraft) report("failed");
        else if (status === "saved" || status === "invalid" || (wasInvalid && status === "failed"))
          report("unsaved");
      }
      schedule();
      return true;
    },
    // Manual save/reconnect can retry a failed request with its original mutation ID
    // A 409 or rejected request stays paused for the owning session to resolve
    flush,
    getStatus: () => status,
    // A departure decision must confirm the exact bytes the user chose to preserve
    getDocumentJson: () => latestJson,
    getExportJson: () => serializeProject(latestDocument, options.assetKinds),
    getRecovery: () => ({
      document: latestDocument,
      serverSave: {
        revision: progress.getSnapshot().revision,
        confirmedJson,
        pending,
      },
    }),
    checkpoint: () => backup(),
    // Recovery is restored paused; the owner resumes after checking the active account
    resume() {
      if (!disposed && progress.getSnapshot().dirty) schedule();
    },
    dispose() {
      if (disposed) return backupQueue;
      disposed = true;
      saveTimer.cancel();
      cancellation.abort();
      // Capture edits still inside the debounce window before leaving this account
      // This final write stays local; no request may start after disposal
      void backup(true);
      // Session cleanup waits for storage already in progress before inspecting its final record
      return backupQueue;
    },
  };
}
