import { readOlderSceneFile } from "../../shared/project/legacy-scene-import";
import { serializeProject } from "../../shared/project/project-serialization";
import { deserializeProject } from "../../shared/project/project-deserialization";
import type { ProjectDocument } from "../../shared/project/project-types";
import {
  checkFields,
  invalid,
  isRecord,
  type ValidationResult,
} from "../../shared/project/validation-helpers";
import type { ProjectFileHandle } from "./project-files";
import { validateRecoveryHistory, type RecoveryHistory } from "../recovery-history";
import {
  IndexedDBDraftDatabase,
  DRAFT_STORE_NAME as STORE_NAME,
  SESSION_STORE_NAME,
  LOCAL_PRINCIPAL,
  isCounter,
  type IDraftDatabase,
} from "./draft-db";
import { validateServerSaveRecovery, type ServerSaveRecovery } from "./server-save-recovery";

export function isPristineLocalProject(document: ProjectDocument): boolean {
  return (
    document.schemaVersion === 1 &&
    document.scenes.length === 1 &&
    document.scenes[0]?.objects.length === 0 &&
    !document.scenes[0]?.viewpoints?.length
  );
}

// One active editing session, including the last manual save for dirty-state comparison
// Replacing this record discards the previous session only after the next one commits
export type RecoverySession = Readonly<{
  revision: number;

  // Null records local room selection or an account-scoped cleared cache with its revision
  document: ProjectDocument | null;
  fileName: string;
  savedJson: string | null;
  pristine: boolean;

  // Keep the chosen file with this exact session so a reload can still Save in place
  // Older records only have the filename and need one more Open to connect it
  fileHandle?: ProjectFileHandle | null;
  fileText?: string;
  history?: RecoveryHistory;
  historyWarning?: string;
  // Present for signed-in project recovery; local JSON-file sessions omit this
  serverSave?: ServerSaveRecovery;
  olderSceneFile?: { text: string; name: string };
}>;

// Account ID comes from the authenticated session
// This key separates backups; server permissions still decide access to the project
export type RecoveryScope = Readonly<{ accountId: string; projectId: string }>;

export type RecoverySaveOptions =
  | { previousProjectId?: string | undefined; scope?: never }
  | { scope: RecoveryScope; previousProjectId?: never };

function recoveryKey(scope: RecoveryScope | undefined): IDBValidKey | null {
  // Keep the existing local-only session readable
  // Signed-in sessions use an exact account/project key and never fall back to it
  if (scope === undefined) return "active";
  if (
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
  scope?: RecoveryScope,
): Promise<ValidationResult<RecoverySession | null>> {
  return await getRecoverySession(assetKinds, new IndexedDBDraftDatabase(), scope);
}

export async function getOlderRecoveryFiles(
  assetKinds: ReadonlyMap<string, string>,
  database: IDraftDatabase = new IndexedDBDraftDatabase(),
): Promise<{ text: string; name: string }[]> {
  const connection = await database.getIndexedDB();
  try {
    return await new Promise((resolve, reject) => {
      const files: { text: string; name: string }[] = [];
      const tx = connection.transaction(SESSION_STORE_NAME, "readonly");
      const read = tx.objectStore(SESSION_STORE_NAME).openCursor();
      read.onsuccess = () => {
        const cursor = read.result;
        if (!cursor) return;
        const raw: unknown = cursor.value;
        if (
          typeof cursor.primaryKey === "string" &&
          cursor.primaryKey.startsWith("older-scene-backup:") &&
          isRecord(raw) &&
          typeof raw.document === "string" &&
          readOlderSceneFile(raw.document, assetKinds).ok
        ) {
          files.push({
            text: raw.document,
            name:
              typeof raw.fileName === "string" && raw.fileName ? raw.fileName : "older-scene.json",
          });
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(files);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    connection.close();
  }
}

export async function getRecoverySession(
  assetKinds: ReadonlyMap<string, string>,
  database: IDraftDatabase,
  scope?: RecoveryScope,
): Promise<ValidationResult<RecoverySession | null>> {
  // Capture identity before IndexedDB yields to a possible account switch
  const key = recoveryKey(scope);
  if (key === null) return invalid("storage", "Invalid recovery account or project");
  const projectId = scope?.projectId.toLowerCase();
  let connection: IDBDatabase;
  try {
    connection = await database.getIndexedDB();
  } catch {
    return invalid("storage", "Recovery storage could not open; your saved data was kept");
  }
  try {
    const raw: unknown = await new Promise((resolve, reject) => {
      const tx = connection.transaction(SESSION_STORE_NAME, "readonly");
      const read = tx.objectStore(SESSION_STORE_NAME).get(key);
      tx.oncomplete = () => resolve(read.result);
      tx.onabort = () => reject(tx.error);
    });
    if (raw === undefined) {
      return { ok: true, value: null };
    }
    if (scope !== undefined && isRecord(raw) && raw.cleared === true) {
      const fields = checkFields(raw, ["revision", "cleared"], "recovery");
      if (!fields.ok) return fields;
      if (!isCounter(raw.revision) || raw.revision < 1) {
        return invalid("storage", "Cleared recovery revision is invalid; the stored copy was kept");
      }
      return {
        ok: true,
        value: {
          revision: raw.revision,
          document: null,
          fileName: "",
          savedJson: null,
          pristine: true,
        },
      };
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
    // Check the session envelope before interpreting its optional file and history metadata
    const fields = checkFields(
      raw,
      [
        "revision",
        "document",
        "fileName",
        "savedJson",
        "pristine",
        ...(Object.hasOwn(raw, "fileHandle") ? ["fileHandle"] : []),
        ...(Object.hasOwn(raw, "fileText") ? ["fileText"] : []),
        ...(Object.hasOwn(raw, "history") ? ["history"] : []),
        ...(Object.hasOwn(raw, "serverSave") ? ["serverSave"] : []),
      ],
      "recovery",
    );
    if (!fields.ok) {
      return fields;
    }
    if (raw.document === null) {
      // Keep a revision even without a project so an older tab cannot overwrite New
      if (
        raw.fileName !== "" ||
        raw.savedJson !== null ||
        !raw.pristine ||
        raw.history !== undefined ||
        raw.serverSave !== undefined ||
        scope !== undefined
      ) {
        return invalid("storage", "Empty recovery session contains project metadata");
      }
      return {
        ok: true,
        value: {
          revision: raw.revision,
          document: null,
          fileName: "",
          savedJson: null,
          pristine: true,
        },
      };
    }
    const document = deserializeProject(raw.document, assetKinds, { allowDraftLinks: true });
    if (!document.ok) {
      const older =
        typeof raw.document === "string" ? readOlderSceneFile(raw.document, assetKinds) : null;
      if (scope !== undefined || raw.serverSave !== undefined || !older?.ok) return document;
      // Offer local older-format conversion explicitly without changing authenticated recovery or retry metadata
      return {
        ok: true,
        value: {
          revision: raw.revision,
          document: null,
          fileName: "",
          savedJson: null,
          pristine: true,
          olderSceneFile: {
            text: raw.document as string,
            name: raw.fileName || "older-scene.json",
          },
        },
      };
    }

    // Validate the pending request alongside the scene before offering recovery
    // A damaged retry record must stay stored for inspection rather than being sent
    const serverSave =
      raw.serverSave === undefined
        ? undefined
        : validateServerSaveRecovery(raw.serverSave, document.value.projectId, assetKinds);
    if (serverSave && !serverSave.ok) return serverSave;
    if (serverSave && scope === undefined)
      return invalid("storage", "Server recovery requires an account and project");
    if (projectId !== undefined && document.value.projectId.toLowerCase() !== projectId)
      return invalid(
        "storage",
        "Recovery belongs to a different project; the stored copy was kept",
      );
    // Keep the valid scene available even if an older history record cannot be restored
    const history =
      raw.history === undefined
        ? undefined
        : validateRecoveryHistory(raw.history, document.value, assetKinds);
    // Restore the manual-save baseline separately from newer edits in the recovery document
    let savedJson: string | null = null;
    if (raw.savedJson !== null) {
      const saved = deserializeProject(raw.savedJson, assetKinds);
      if (!saved.ok) {
        return saved;
      }
      if (saved.value.projectId !== document.value.projectId) {
        return invalid("storage", "Recovery file belongs to a different project");
      }
      const encoded = serializeProject(saved.value, assetKinds);
      if (!encoded.ok) return encoded;
      savedJson = encoded.value;
    }

    // File contents can include whitespace; keep the exact text for overwrite checks
    // A filename by itself never grants access to a file on someone's computer
    let fileHandle: ProjectFileHandle | null = null;
    let fileText = "";
    if (
      typeof FileSystemFileHandle !== "undefined" &&
      raw.fileHandle instanceof FileSystemFileHandle &&
      raw.fileHandle.kind === "file" &&
      raw.fileHandle.name === raw.fileName &&
      typeof raw.fileText === "string" &&
      savedJson !== null
    ) {
      // Match the stored connection to the saved version before reusing it
      // A stale or incomplete connection can be ignored without losing the scene
      const baseline = deserializeProject(raw.fileText, assetKinds);
      const canonical = baseline.ok ? serializeProject(baseline.value, assetKinds) : baseline;
      if (canonical.ok && canonical.value === savedJson) {
        fileHandle = raw.fileHandle as unknown as ProjectFileHandle;
        fileText = raw.fileText;
      }
    }
    return {
      ok: true,
      value: {
        revision: raw.revision,
        document: document.value,
        fileName: raw.fileName,
        savedJson,
        pristine: raw.pristine && isPristineLocalProject(document.value),
        fileHandle,
        fileText,
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
export async function saveRecoverySession(
  session: Omit<RecoverySession, "revision" | "historyWarning" | "olderSceneFile">,
  expectedRevision: number,
  assetKinds: ReadonlyMap<string, string>,
  options: RecoverySaveOptions = {},
): Promise<ValidationResult<number>> {
  return await applySaveRecoverySession(
    session,
    expectedRevision,
    assetKinds,
    new IndexedDBDraftDatabase(),
    options,
  );
}

export async function applySaveRecoverySession(
  session: Omit<RecoverySession, "revision" | "historyWarning" | "olderSceneFile">,
  expectedRevision: number,
  assetKinds: ReadonlyMap<string, string>,
  database: IDraftDatabase,
  { previousProjectId, scope }: RecoverySaveOptions = {},
): Promise<ValidationResult<number>> {
  // Scoped backups must never replace another project's record or the local-only session
  const key = recoveryKey(scope);
  if (key === null) {
    return invalid("storage", "Invalid recovery account or project");
  }
  if (
    scope !== undefined &&
    session.document?.projectId.toLowerCase() !== scope.projectId.toLowerCase()
  ) {
    return invalid("storage", "Recovery belongs to a different project");
  }
  if (!isCounter(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER) {
    return invalid("storage", "Invalid recovery revision");
  }

  // Empty sessions use the same atomic write and revision checks as authored projects
  const encoded =
    session.document === null
      ? { ok: true as const, value: null }
      : serializeProject(session.document, assetKinds, { allowDraftLinks: true });
  if (!encoded.ok) {
    return encoded;
  }
  if (
    session.document === null &&
    (session.fileName !== "" ||
      session.savedJson !== null ||
      !session.pristine ||
      session.history !== undefined)
  ) {
    return invalid("storage", "Empty recovery session contains project metadata");
  }
  // Server retry metadata only belongs to a nonempty authenticated project
  if (session.serverSave !== undefined) {
    if (scope === undefined || session.document === null) {
      return invalid("storage", "Server recovery requires an account and project");
    }
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
    session.history === undefined || session.document === null
      ? undefined
      : validateRecoveryHistory(session.history, session.document, assetKinds);
  if (history && !history.ok) {
    return history;
  }
  if (session.fileName.length > 255) {
    return invalid("storage", "Project filename is too long");
  }
  // A baseline must be valid and belong to this project before it can influence dirty status
  if (session.savedJson !== null) {
    const saved = deserializeProject(session.savedJson, assetKinds);
    if (!saved.ok) {
      return saved;
    }
    if (saved.value.projectId !== session.document?.projectId) {
      return invalid("storage", "Recovery file belongs to a different project");
    }
  }
  let connection: IDBDatabase;
  try {
    connection = await database.getIndexedDB();
  } catch {
    return invalid(
      "storage",
      "Recovery backup failed; keep this tab open and save your project file",
    );
  }
  return new Promise((resolve) => {
    let message = "Recovery backup failed; your current project is still open";
    try {
      // Only local sessions retire legacy drafts; scoped saves leave other recovery untouched
      const tx = connection.transaction(
        scope === undefined ? [SESSION_STORE_NAME, STORE_NAME] : [SESSION_STORE_NAME],
        "readwrite",
      );
      const store = tx.objectStore(SESSION_STORE_NAME);
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
          message = "Recovery changed in another tab; save your JSON file before refreshing";
          tx.abort();
          return;
        }

        // Keep the scene and manual-save baseline together in one atomic write
        // Don't Save switches to a new record without leaving the discarded edits behind
        try {
          // Keep the original local older-format backup and history before replacement
          // Revision checks prevent archiving or overwriting another tab's newer work
          if (
            scope === undefined &&
            isRecord(previous) &&
            typeof previous.document === "string" &&
            !deserializeProject(previous.document, assetKinds).ok &&
            readOlderSceneFile(previous.document, assetKinds).ok
          ) {
            store.put(previous, `older-scene-backup:${expectedRevision}`);
          }
          store.put({ ...session, document: encoded.value, revision: expectedRevision + 1 }, key);
          if (scope === undefined) {
            const legacy = tx.objectStore(STORE_NAME);
            if (session.document) {
              legacy.delete([LOCAL_PRINCIPAL, session.document.projectId.toLowerCase()]);
            }
            if (previousProjectId) {
              legacy.delete([LOCAL_PRINCIPAL, previousProjectId.toLowerCase()]);
            }
          }
        } catch {
          // Cloning a file handle or starting the write can fail before a request exists
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
      // Compare and clear in one transaction so a newer tab's edits survive cleanup
      const tx = connection.transaction(SESSION_STORE_NAME, "readwrite");
      const store = tx.objectStore(SESSION_STORE_NAME);
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
          !isCounter(raw.revision) ||
          raw.revision < 1 ||
          !isRecord(raw.serverSave) ||
          raw.serverSave.pending !== null ||
          typeof raw.document !== "string" ||
          raw.document !== raw.serverSave.confirmedJson
        )
          return;
        try {
          // Keep the revision so another tab cannot reuse an old counter after cleanup
          store.put({ revision: raw.revision, cleared: true }, key);
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
