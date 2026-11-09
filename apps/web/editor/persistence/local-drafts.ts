import { serializeProject } from "../../shared/project/project-serialization";
import { deserializeProject } from "../../shared/project/project-deserialization";
import type { ProjectDocument } from "../../shared/project/project-types";
import { checkFields, invalid, isRecord } from "../../shared/project/validation-helpers";
import type { ValidationResult } from "../../shared/project/validation-helpers";
import { validateRecoveryHistory, type RecoveryHistory } from "../recovery-history";
import { IndexedDBDraftDatabase, type IDraftDatabase } from "./draft-db";
import { validateServerSaveRecovery, type ServerSaveRecovery } from "./server-save-recovery";

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type RecoverySession = Readonly<{
  revision: number;

  document: ProjectDocument;
  history?: RecoveryHistory;
  historyWarning?: string;
  // Older account-scoped backups without retry metadata can still be exported.
  serverSave?: ServerSaveRecovery;
}>;

// Account ID comes from the authenticated session
// This key separates backups; server permissions still decide access to the project
export type RecoveryScope = Readonly<{ accountId: string; projectId: string }>;

function recoveryKey(scope: RecoveryScope): IDBValidKey | null {
  if (
    !scope ||
    !scope.accountId.trim() ||
    !scope.projectId.trim() ||
    scope.accountId.length > 255 ||
    scope.projectId.length > 255
  )
    return null;
  // Array keys keep account and project IDs in separate parts of the IndexedDB key
  return ["account", scope.accountId.toLowerCase(), scope.projectId.toLowerCase()];
}

export async function loadRecoverySession(
  assetKinds: ReadonlyMap<string, string>,
  scope: RecoveryScope,
): Promise<ValidationResult<RecoverySession | null>> {
  return await getRecoverySession(assetKinds, new IndexedDBDraftDatabase(), scope);
}

export async function getRecoverySession(
  assetKinds: ReadonlyMap<string, string>,
  database: IDraftDatabase,
  scope: RecoveryScope,
): Promise<ValidationResult<RecoverySession | null>> {
  // Capture identity before IndexedDB yields to a possible account switch
  const key = recoveryKey(scope);
  if (key === null) return invalid("storage", "Invalid recovery account or project");
  const projectId = scope.projectId.toLowerCase();
  let connection: IDBDatabase;
  try {
    connection = await database.getIndexedDB();
  } catch {
    return invalid("storage", "Recovery storage could not open; your saved data was kept");
  }
  try {
    const raw: unknown = await new Promise((resolve, reject) => {
      const tx = connection.transaction("session", "readonly");
      const read = tx.objectStore("session").get(key);
      tx.oncomplete = () => resolve(read.result);
      tx.onabort = () => reject(tx.error);
    });
    if (raw === undefined) {
      return { ok: true, value: null };
    }
    if (
      !isRecord(raw) ||
      !isCounter(raw.revision) ||
      raw.revision < 1 ||
      typeof raw.fileName !== "string" ||
      raw.fileName.length > 255 ||
      typeof raw.pristine !== "boolean" ||
      (raw.savedJson !== null && typeof raw.savedJson !== "string")
    ) {
      return invalid("storage", "Recovery metadata is invalid; the stored copy was kept");
    }
    const fields = checkFields(
      raw,
      ["revision", "document", "fileName", "savedJson", "pristine"],
      "recovery",
      ["history", "serverSave", "fileHandle", "fileText"],
    );
    if (!fields.ok) {
      return fields;
    }
    const document = deserializeProject(raw.document, assetKinds, { allowDraftLinks: true });
    if (!document.ok) return document;
    // Validate the pending request alongside the scene before offering recovery
    // A damaged retry record must stay stored for inspection rather than being sent
    const serverSave =
      raw.serverSave === undefined
        ? undefined
        : validateServerSaveRecovery(raw.serverSave, document.value.projectId, assetKinds);
    if (serverSave && !serverSave.ok) return serverSave;
    if (document.value.projectId.toLowerCase() !== projectId)
      return invalid(
        "storage",
        "Recovery belongs to a different project; the stored copy was kept",
      );
    // Keep the valid scene available even if an older history record cannot be restored
    const history =
      raw.history === undefined
        ? undefined
        : validateRecoveryHistory(raw.history, document.value, assetKinds);
    // Validate any manual-save baseline from older records before accepting their document.
    if (raw.savedJson !== null) {
      const baseline = deserializeProject(raw.savedJson, assetKinds);
      if (!baseline.ok) return baseline;
      if (baseline.value.projectId !== document.value.projectId)
        return invalid("storage", "Recovery file belongs to a different project");
    }
    return {
      ok: true,
      value: {
        revision: raw.revision,
        document: document.value,
        ...(serverSave?.ok ? { serverSave: serverSave.value } : {}),
        ...(history?.ok ? { history: history.value } : {}),
        ...(history && !history.ok
          ? { historyWarning: "Scene recovered, but its undo history could not be restored" }
          : {}),
      },
    };
  } catch {
    return invalid("storage", "Recovery could not be read; the stored copy was kept");
  } finally {
    connection.close();
  }
}

export async function applySaveRecoverySession(
  session: Omit<RecoverySession, "revision" | "historyWarning">,
  expectedRevision: number,
  assetKinds: ReadonlyMap<string, string>,
  database: IDraftDatabase,
  scope: RecoveryScope,
): Promise<ValidationResult<number>> {
  // Scoped backups must never replace another project's record or the local-only session
  const key = recoveryKey(scope);
  if (key === null) {
    return invalid("storage", "Invalid recovery account or project");
  }
  if (session.document?.projectId.toLowerCase() !== scope.projectId.toLowerCase()) {
    return invalid("storage", "Recovery belongs to a different project");
  }
  if (!isCounter(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER) {
    return invalid("storage", "Invalid recovery revision");
  }

  const encoded = serializeProject(session.document, assetKinds, { allowDraftLinks: true });
  if (!encoded.ok) {
    return encoded;
  }
  if (session.serverSave !== undefined) {
    const serverSave = validateServerSaveRecovery(
      session.serverSave,
      session.document.projectId,
      assetKinds,
    );
    if (!serverSave.ok) {
      return serverSave;
    }
  }
  const history =
    session.history === undefined
      ? undefined
      : validateRecoveryHistory(session.history, session.document, assetKinds);
  if (history && !history.ok) {
    return history;
  }
  let connection: IDBDatabase;
  try {
    connection = await database.getIndexedDB();
  } catch {
    return invalid("storage", "Recovery backup failed; keep this tab open and export your project");
  }
  return new Promise((resolve) => {
    let message = "Recovery backup failed; your current project is still open";
    try {
      const tx = connection.transaction("session", "readwrite");
      const store = tx.objectStore("session");
      const read = store.get(key);
      tx.onabort = () => {
        connection.close();
        resolve(invalid("storage", message));
      };
      tx.oncomplete = () => {
        connection.close();
        resolve({ ok: true, value: expectedRevision + 1 });
      };
      read.onsuccess = () => {
        const previous: unknown = read.result;
        if (previous !== undefined && (!isRecord(previous) || !isCounter(previous.revision))) {
          message = "Recovery metadata is invalid; the stored copy was kept";
          tx.abort();
          return;
        }
        if ((isRecord(previous) ? previous.revision : 0) !== expectedRevision) {
          // Both tabs share this record; only the tab with the latest revision can replace it
          message = "Recovery changed in another tab; export your edits before refreshing";
          tx.abort();
          return;
        }

        try {
          // Keep the version-2 envelope readable by previously opened browser tabs.
          store.put(
            {
              ...session,
              fileName: "",
              savedJson: null,
              pristine: false,
              document: encoded.value,
              revision: expectedRevision + 1,
            },
            key,
          );
        } catch {
          try {
            tx.abort();
          } catch {
            // An earlier request already aborted it; onabort still reports the failure
          }
        }
      };
    } catch {
      connection.close();
      resolve(invalid("storage", message));
    }
  });
}

// Closing an authenticated session can remove its confirmed cache
// Keep uncertain requests and unsynced edits available to the original account
export async function clearConfirmedServerRecovery(
  scope: RecoveryScope,
  database: IDraftDatabase = new IndexedDBDraftDatabase(),
): Promise<ValidationResult<boolean>> {
  const key = recoveryKey(scope);
  if (key === null) return invalid("storage", "Invalid recovery account or project");
  // Open only the account-scoped record after validating its identity
  let connection: IDBDatabase;
  try {
    connection = await database.getIndexedDB();
  } catch {
    return invalid("storage", "Recovery storage could not open");
  }
  return new Promise((resolve) => {
    let removed = false;
    try {
      // Compare and delete in one transaction so a newer tab's edits survive cleanup
      const tx = connection.transaction("session", "readwrite");
      const store = tx.objectStore("session");
      const read = store.get(key);
      tx.onabort = () => {
        connection.close();
        resolve(invalid("storage", "Recovery cache could not be cleared"));
      };
      tx.oncomplete = () => {
        connection.close();
        resolve({ ok: true, value: removed });
      };
      read.onsuccess = () => {
        const raw: unknown = read.result;
        // Only remove an exact confirmed copy with no outstanding request
        // Missing metadata or newer local edits leave the backup in place
        if (
          !isRecord(raw) ||
          !isRecord(raw.serverSave) ||
          raw.serverSave.pending !== null ||
          typeof raw.document !== "string" ||
          raw.document !== raw.serverSave.confirmedJson
        )
          return;
        try {
          store.delete(key);
          removed = true;
        } catch {
          tx.abort();
        }
      };
    } catch {
      connection.close();
      resolve(invalid("storage", "Recovery cache could not be cleared"));
    }
  });
}
