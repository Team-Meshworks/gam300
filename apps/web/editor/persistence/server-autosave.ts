import type { ProjectDocument } from "../../shared/project/project-types";
import { serializeProject } from "../../shared/project/project-serialization";
import { createServerSaveProgress } from "./server-save-progress";
import { createServerSaveTimer } from "./server-save-timer";
import { validateServerSaveRecovery, type ServerSaveRecovery } from "./server-save-recovery";
import type { ServerDraftRequest, ServerDraftResult } from "./server-draft-write";

export type ServerSaveStatus =
  | "saved"
  | "unsaved"
  | "saving"
  | "failed"
  | "conflict"
  | "rejected"
  | "invalid";

export type ServerSaveSnapshot = Readonly<{
  document: ProjectDocument;
  serverSave: ServerSaveRecovery;
}>;

// Create after opening a confirmed server document
// Dispose before changing account/project; the existing session still owns local recovery
export function createServerAutosave(options: {
  document: ProjectDocument;
  revision: number;
  assetKinds: ReadonlyMap<string, string>;
  onStatus: (status: ServerSaveStatus) => void;
  write: (request: ServerDraftRequest, signal: AbortSignal) => Promise<ServerDraftResult>;
  recovery?: ServerSaveRecovery;
  // Resolve only after IndexedDB commits the scene and pending request together
  checkpoint: (snapshot: ServerSaveSnapshot) => Promise<boolean>;
}) {
  const initial = serializeProject(options.document, options.assetKinds, { allowDraftLinks: true });
  if (!initial.ok) throw new Error(initial.error.message);
  const projectId = options.document.projectId;
  const restored = options.recovery
    ? validateServerSaveRecovery(options.recovery, projectId, options.assetKinds)
    : undefined;
  if (restored && !restored.ok) throw new Error("Invalid server recovery state");
  const progress = createServerSaveProgress(
    projectId,
    options.revision,
    initial.value,
    restored?.value,
  );
  // Latest scene keeps changing as the student edits
  // Confirmed JSON stays at the last server acknowledgement
  // Pending JSON holds the particular scene already queued for sending
  let latestJson = initial.value;
  let latestDocument = options.document;
  let invalidDraft = !serializeProject(latestDocument, options.assetKinds).ok;
  let status: ServerSaveStatus = progress.getSnapshot().dirty ? "unsaved" : "saved";
  let running = false;
  let activeSave: Promise<void> | undefined;
  let disposed = false;
  const cancellation = new AbortController();
  let checkpointed = Promise.resolve(true);
  const saveTimer = createServerSaveTimer(() => {
    // Local recovery keeps running while network saves are paused
    if (running || ["failed", "conflict", "rejected", "invalid"].includes(status)) {
      void backup().then((ok) => {
        if (!ok && !disposed && status !== "conflict" && status !== "rejected") report("failed");
      });
    } else void flush();
  });

  function getRecovery(): ServerSaveSnapshot {
    return Object.freeze({
      document: latestDocument,
      serverSave: progress.getRecovery(),
    });
  }

  function backup(finalSnapshot = false) {
    if (disposed && !finalSnapshot) return Promise.resolve(false);
    try {
      // The owner captures history synchronously, then orders storage writes.
      checkpointed = options.checkpoint(getRecovery()).catch(() => false);
    } catch {
      checkpointed = Promise.resolve(false);
    }
    return checkpointed;
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
    let attempt = progress.getSnapshot().pending;
    // An unfinished newer edit must not block a retry of already captured valid bytes.
    if (invalidDraft && !attempt) {
      const backedUp = await backup();
      running = false;
      if (disposed) return;
      report(backedUp && !invalidDraft ? "unsaved" : "failed");
      if (status === "unsaved") schedule();
      return;
    }
    if (!attempt) {
      if (
        progress.getSnapshot().dirty &&
        progress.getSnapshot().revision === Number.MAX_SAFE_INTEGER
      ) {
        await backup();
        running = false;
        if (!disposed) report("rejected");
        return;
      }
      attempt = progress.begin(crypto.randomUUID(), latestJson);
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
      result = await options.write(attempt.request, cancellation.signal);
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
      // Store the acknowledgement so recovery knows which request has finished
      const backedUp = await backup();
      running = false;
      if (disposed) return;
      report(
        backedUp && !invalidDraft ? (progress.getSnapshot().dirty ? "unsaved" : "saved") : "failed",
      );
      if (progress.getSnapshot().dirty) schedule();
    } else if (result.kind === "invalid") {
      const rejectedJson = attempt.documentJson;
      progress.reject();
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
    getRecovery,
    checkpoint: () => backup(),
    // Recovery is restored paused; the owner resumes after checking the active account
    resume() {
      if (!disposed && progress.getSnapshot().dirty) schedule();
    },
    dispose() {
      if (disposed) return checkpointed;
      disposed = true;
      saveTimer.cancel();
      cancellation.abort();
      // Capture edits still inside the debounce window before leaving this account
      // This final write stays local; no request may start after disposal
      // Session cleanup waits for its queued storage writes before inspecting the final record
      return backup(true);
    },
  };
}
