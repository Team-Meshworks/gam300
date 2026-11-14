import type { createDocumentStore } from "../document-store";
import { deserializeProject } from "../../shared/project/project-deserialization";
import { serializeProject } from "../../shared/project/project-serialization";
import { invalid, type ValidationResult } from "../../shared/project/validation-helpers";
import { IndexedDBDraftDatabase, type IDraftDatabase } from "./draft-db";
import {
  applySaveRecoverySession,
  clearConfirmedServerRecovery,
  type RecoverySession,
} from "./local-drafts";
import { createServerAutosave, type ServerSaveStatus } from "./server-autosave";
import {
  writeServerDraft,
  type ServerDraftRequest,
  type ServerDraftResult,
} from "./server-draft-write";

// Attach after the owner loads a server document or explicitly chooses its recovery copy
// The account signal must abort on logout, account change or closing the project
export function connectServerProjectSession(options: {
  accountId: string;
  store: ReturnType<typeof createDocumentStore>;
  revision: number;
  storageRevision: number;
  assetKinds: ReadonlyMap<string, string>;
  signal: AbortSignal;
  onStatus: (status: ServerSaveStatus) => void;
  recovery?: RecoverySession;
  database?: IDraftDatabase;
  events?: EventTarget;
  write?: (request: ServerDraftRequest, signal: AbortSignal) => Promise<ServerDraftResult>;
}) {
  // Check account and recovery state before attaching listeners
  const document = options.store.getSnapshot().project;
  if (!document || !options.accountId.trim() || options.signal.aborted)
    throw new Error("An active account and project are required");
  if (!Number.isSafeInteger(options.storageRevision) || options.storageRevision < 0)
    throw new Error("Invalid recovery revision");
  // Recovery must describe the scene the owner actually chose to open
  // Mixing a server scene with another recovery snapshot would replay the wrong edits
  if (options.recovery) {
    const recovered = serializeProject(options.recovery.document, options.assetKinds, {
      allowDraftLinks: true,
    });
    const opened = serializeProject(document, options.assetKinds, { allowDraftLinks: true });
    if (
      !options.recovery.serverSave ||
      options.recovery.revision !== options.storageRevision ||
      !recovered.ok ||
      !opened.ok ||
      recovered.value !== opened.value
    )
      throw new Error("Recovery does not match the opened project");
  }

  // Capture identity once; later callbacks always belong to this account/project pair
  const scope = Object.freeze({ accountId: options.accountId, projectId: document.projectId });
  const database = options.database ?? new IndexedDBDraftDatabase();
  const events = options.events ?? (typeof window === "undefined" ? undefined : window);
  // IndexedDB revision catches another tab replacing this backup
  // Server revision is tracked separately by autosave
  let storageRevision = options.storageRevision;
  let disposed = false;
  let backupError = "";
  let closing: Promise<ValidationResult<boolean>> | undefined;
  // Hold onto the previous project's history when the store switches projects
  // Its final queued backup may run after the new scene has loaded
  let capturedHistory = options.store.getRecoveryHistory();
  let historyDocument = serializeProject(document, options.assetKinds, { allowDraftLinks: true });
  // Connect server writes to account-scoped recovery before watching edits
  const autosave = createServerAutosave({
    document,
    revision: options.revision,
    assetKinds: options.assetKinds,
    onStatus: (status) => {
      if (!disposed) options.onStatus(status);
    },
    ...(options.recovery?.serverSave ? { recovery: options.recovery.serverSave } : {}),
    // Bind every default write to this owner, including a retry after cookies change in another tab
    write:
      options.write ??
      ((request, signal) => writeServerDraft(request, signal, fetch, scope.accountId)),
    backup: async (documentJson, serverSave) => {
      const parsed = deserializeProject(documentJson, options.assetKinds, {
        allowDraftLinks: true,
      });
      if (!parsed.ok) {
        backupError = parsed.error.message;
        return false;
      }
      // History belongs to the captured scene, not whichever scene happens to be open later
      const history =
        historyDocument.ok && historyDocument.value === documentJson ? capturedHistory : undefined;
      // Save the scene and pending request together under the expected local revision
      const result = await applySaveRecoverySession(
        {
          document: parsed.value,
          serverSave,
          ...(history ? { history } : {}),
        },
        storageRevision,
        options.assetKinds,
        database,
        scope,
      );
      // Final backup may finish after logout, still under the captured account key
      // Only this disposed owner's storage counter changes; no editor callbacks run
      if (!result.ok) {
        backupError = result.error.message;
        return false;
      }
      backupError = "";
      storageRevision = result.value;
      return true;
    },
  });

  // Stop this session as soon as the editor switches to another project
  const unsubscribe = options.store.subscribe(() => {
    const next = options.store.getSnapshot().project;
    if (!next || next.projectId !== scope.projectId) {
      dispose();
      return;
    }
    // Document subscriptions fire for committed edits and undo/redo
    // Drag previews stay outside this path
    capturedHistory = options.store.getRecoveryHistory();
    historyDocument = serializeProject(next, options.assetKinds, { allowDraftLinks: true });
    autosave.changed(next);
  });
  // Online only means the browser has a connection again
  // The save still needs a server reply before the status can become saved
  const reconnect = () => void autosave.flush();
  events?.addEventListener("online", reconnect);
  options.signal.addEventListener("abort", dispose, { once: true });

  // Detach listeners before finishing recovery for the previous account
  function dispose() {
    if (disposed) return closing;
    disposed = true;
    unsubscribe();
    events?.removeEventListener("online", reconnect);
    options.signal.removeEventListener("abort", dispose);
    // Finish the last local snapshot before deciding whether its cache can be removed
    // Unsynced work stays available to the original account
    closing = autosave
      .dispose()
      .then((ok) =>
        ok
          ? clearConfirmedServerRecovery(scope, database)
          : invalid("storage", "Final recovery backup failed; keep the project open and export it"),
      );
    return closing;
  }

  options.onStatus(autosave.getStatus());
  autosave.resume();
  return {
    // The screen asks the user for this choice before invoking logout or replacing its store
    // Failed saves, failed exports and edits made during the decision keep this session open
    async prepareToLeave(
      choice: "save" | "recovery" | "export" | "cancel",
      exportFile?: (json: string) => Promise<boolean>,
    ): Promise<ValidationResult<boolean>> {
      if (disposed || choice === "cancel") {
        return { ok: true, value: false };
      }
      // Check the chosen version again after the preservation decision finishes
      const captured = autosave.getDocumentJson();
      let preserved: boolean;
      try {
        // Each choice must confirm preservation before allowing the user to leave
        if (choice === "save") {
          await autosave.flush();
          preserved = autosave.getStatus() === "saved";
        } else if (choice === "recovery") {
          preserved = await autosave.checkpoint();
        } else {
          // A dismissed picker or failed write must never count as a successful export
          const exported = autosave.getExportJson();
          if (!exported.ok) return exported;
          preserved = (await exportFile?.(exported.value)) === true;
        }
      } catch {
        preserved = false;
      }
      if (choice === "recovery" && !preserved) {
        return invalid(
          "storage",
          backupError ||
            "Browser backup failed. Keep editing or export your changes before leaving.",
        );
      }
      if (disposed || !preserved || captured !== autosave.getDocumentJson()) {
        return invalid(
          "session",
          "Work is not fully preserved; keep this project open and retry or export",
        );
      }
      // Stop outgoing saves synchronously before the caller starts a different session
      // A successful export remains usable even if the final local backup subsequently fails
      // The chosen destination already confirmed these exact bytes before disposal
      // Cleanup is best effort here; its failure cannot invalidate that confirmed copy
      void dispose();
      return { ok: true, value: true };
    },
    getRecovery: (): RecoverySession => ({
      ...autosave.getRecovery(),
      revision: storageRevision,
      ...(capturedHistory ? { history: capturedHistory } : {}),
    }),
    flush: autosave.flush,
    getStatus: autosave.getStatus,
    dispose,
  };
}
