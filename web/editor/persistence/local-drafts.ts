import { serializeProject } from "../../shared/project/project-serialization";
import { deserializeProject } from "../../shared/project/project-deserialization";
import type { ProjectDocument } from "../../shared/project/project-types";
import { checkFields, invalid, isRecord } from "../../shared/project/validation-helpers";
import type { ValidationResult } from "../../shared/project/validation-helpers";
import type { ProjectFileHandle } from "./project-files";
import { validateRecoveryHistory, type RecoveryHistory } from "../recovery-history";

// Stable storage names so refreshing the page finds the same records
const DATABASE_NAME = "vthere-local-drafts";
const STORE_NAME = "drafts";
const LOCAL_PRINCIPAL = "local";

type SaveRequest = Readonly<{
  project: unknown;
  history?: unknown;
  // Last storage revision this tab has seen; zero means no existing draft
  expectedStorageRevision: number;
  // Edit counter captured with the project being saved
  localEditSequence: number;
}>;

type SaveReceipt = Readonly<{
  projectId: string;
  localStorageRevision: number;
  localEditSequence: number;
  savedAt: string;
}>;

type RecoveredDraft = SaveReceipt &
  Readonly<{
    document: ProjectDocument;
    history?: RecoveryHistory;
    historyWarning?: string;
    recoveryWarning?: string;
  }>;

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (globalThis.indexedDB === undefined) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    // Database version controls the store layout; project schemaVersion lives in the JSON
    const request = indexedDB.open(DATABASE_NAME, 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      // Keep the local namespace separate from future signed-in account records
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: ["principalKey", "projectId"] });
      }
      if (!request.result.objectStoreNames.contains("session"))
        request.result.createObjectStore("session");
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Another tab is holding the database open"));
    };
    request.onsuccess = () => {
      const database = request.result;
      // Let another tab upgrade storage once this connection is finished
      database.onversionchange = () => database.close();
      // A blocked open can still finish after its caller has received an error
      if (blocked) database.close();
      else resolve(database);
    };
  });
}

function validateStoredDraft(
  raw: unknown,
  projectId: string,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<RecoveredDraft | null> {
  // A missing draft is a normal first visit
  // Damaged records return an error and stay available for recovery
  if (raw === undefined) return { ok: true, value: null };
  if (!isRecord(raw)) return invalid("storage", "Stored draft must be an object");
  const fields = checkFields(
    raw,
    [
      "projectId",
      "principalKey",
      "document",
      "localStorageRevision",
      "localEditSequence",
      "baseServerRevision",
      "pendingMutation",
      "savedAt",
      ...(Object.hasOwn(raw, "history") ? ["history"] : []),
    ],
    "storage",
  );
  if (!fields.ok) return fields;
  // Recovery needs usable counters and a timestamp before offering the draft
  // Server-related fields stay empty for these local M1 records
  if (
    raw.projectId !== projectId ||
    raw.principalKey !== LOCAL_PRINCIPAL ||
    raw.baseServerRevision !== null ||
    raw.pendingMutation !== null ||
    !isCounter(raw.localStorageRevision) ||
    raw.localStorageRevision < 1 ||
    !isCounter(raw.localEditSequence) ||
    typeof raw.savedAt !== "string" ||
    raw.savedAt.length > 30 ||
    !Number.isFinite(Date.parse(raw.savedAt))
  ) {
    return invalid("storage", "Stored draft metadata is invalid or unsupported");
  }
  // Browser storage can be edited or left behind by another application version
  // Use the file reader's size, version and reference checks again
  const document = deserializeProject(raw.document, assetKinds);
  if (!document.ok) return document;
  if (document.value.projectId.toLowerCase() !== projectId) {
    // A valid document under the wrong storage key still belongs to another project
    return invalid("storage.projectId", "Stored document belongs to a different project");
  }
  // A damaged or outdated history must not prevent recovery of a valid scene.
  // Older drafts have no history field and still open normally.
  const history =
    raw.history === undefined
      ? undefined
      : validateRecoveryHistory(raw.history, document.value, assetKinds);
  return {
    ok: true,
    value: {
      projectId,
      document: document.value,
      ...(history?.ok ? { history: history.value } : {}),
      ...(history !== undefined && !history.ok
        ? {
            historyWarning:
              "Scene recovered, but its undo history was invalid and could not be restored.",
          }
        : {}),
      localStorageRevision: raw.localStorageRevision,
      localEditSequence: raw.localEditSequence,
      savedAt: raw.savedAt,
    },
  };
}

// Return a checked draft for the caller to offer to the author
// Reading never replaces the live project or deletes a rejected record
export async function loadLocalDraft(
  projectId: string,
  assetKinds: ReadonlyMap<string, string>,
): Promise<ValidationResult<RecoveredDraft | null>> {
  if (
    typeof projectId !== "string" ||
    projectId.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)
  ) {
    return invalid("storage.projectId", "Expected a project UUID");
  }
  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return invalid("storage", "Local storage could not open; the current project is unchanged");
  }
  const stored = await new Promise<ValidationResult<unknown>>((resolve) => {
    try {
      // Read-only transaction keeps failed recovery from changing the stored copy
      const transaction = database.transaction(STORE_NAME, "readonly");
      const read = transaction
        .objectStore(STORE_NAME)
        .get([LOCAL_PRINCIPAL, projectId.toLowerCase()]);
      transaction.oncomplete = () => {
        // Release the connection before validating the returned JSON
        database.close();
        resolve({ ok: true, value: read.result });
      };
      transaction.onabort = () => {
        database.close();
        resolve(invalid("storage", "Local draft could not be read; try again"));
      };
    } catch {
      database.close();
      resolve(invalid("storage", "Local draft could not be read; try again"));
    }
  });
  if (!stored.ok) return stored;
  return validateStoredDraft(stored.value, projectId.toLowerCase(), assetKinds);
}

// On a fresh page there is no project ID yet; offer the most recently saved local project
export async function loadLatestLocalDraft(
  assetKinds: ReadonlyMap<string, string>,
): Promise<ValidationResult<RecoveredDraft | null>> {
  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return invalid("storage", "Local storage could not open; the current project is unchanged");
  }
  return new Promise<ValidationResult<RecoveredDraft | null>>((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const read = transaction.objectStore(STORE_NAME).openCursor();
      let record: RecoveredDraft | null = null;
      let latestTime = -Infinity;
      let damaged = false;
      read.onsuccess = () => {
        const cursor = read.result;
        if (cursor === null) return;
        const key = cursor.primaryKey;
        if (Array.isArray(key) && key[0] === LOCAL_PRINCIPAL) {
          const checked = validateStoredDraft(cursor.value, String(key[1]), assetKinds);
          // Retain damaged records and ask before recovering a different readable backup
          if (!checked.ok || checked.value === null) {
            damaged = true;
          } else if (Date.parse(checked.value.savedAt) >= latestTime) {
            latestTime = Date.parse(checked.value.savedAt);
            record = checked.value;
          }
        }
        cursor.continue();
      };
      transaction.oncomplete = () => {
        database.close();
        resolve(
          damaged && record === null
            ? invalid("storage", "Stored draft metadata is invalid; existing saves were kept")
            : {
                ok: true,
                value:
                  record && damaged
                    ? {
                        ...record,
                        recoveryWarning:
                          "Another browser backup could not be read and has been kept.",
                      }
                    : record,
              },
        );
      };
      transaction.onabort = () => {
        database.close();
        resolve(invalid("storage", "Local drafts could not be read; try again"));
      };
    } catch {
      database.close();
      resolve(invalid("storage", "Local drafts could not be read; try again"));
    }
  });
}

// Save one snapshot; caller keeps the live document and tracks newer edits separately
// Expected revision zero creates a draft without overwriting an existing record
export async function saveLocalDraft(
  request: SaveRequest,
  assetKinds: ReadonlyMap<string, string>,
): Promise<ValidationResult<SaveReceipt>> {
  if (
    !isCounter(request.expectedStorageRevision) ||
    request.expectedStorageRevision === Number.MAX_SAFE_INTEGER ||
    !isCounter(request.localEditSequence)
  ) {
    return invalid("storage", "Invalid local revision or edit sequence");
  }

  // Capture JSON before waiting on storage so later edits can't enter this write
  const serialized = serializeProject(request.project, assetKinds);
  if (!serialized.ok) return serialized;
  const checked: ProjectDocument = JSON.parse(serialized.value);
  const history =
    request.history === undefined
      ? undefined
      : validateRecoveryHistory(request.history, checked, assetKinds);
  if (history !== undefined && !history.ok) return history;
  // UUID letter case must resolve to the same draft key
  // Original spelling stays inside the saved JSON
  const projectId = checked.projectId.toLowerCase();
  const expectedRevision = request.expectedStorageRevision;
  const editSequence = request.localEditSequence;
  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return invalid("storage", "Local storage could not open; keep this tab open and try again");
  }

  return new Promise((resolve) => {
    let failure = "Local save failed; the current project is still in memory";
    let receipt: SaveReceipt | undefined;
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      transaction.onabort = () => {
        database.close();
        resolve(invalid("storage", failure));
      };
      transaction.oncomplete = () => {
        database.close();
        // A successful put request can still be followed by a failed transaction
        resolve(receipt === undefined ? invalid("storage", failure) : { ok: true, value: receipt });
      };

      // Read and compare in the same transaction as the write
      // Another tab's committed revision must be seen before replacing its draft
      const read = store.get([LOCAL_PRINCIPAL, projectId]);
      read.onsuccess = () => {
        const previous: unknown = read.result;
        if (
          previous !== undefined &&
          (!isRecord(previous) ||
            !isCounter(previous.localStorageRevision) ||
            previous.localStorageRevision < 1 ||
            !isCounter(previous.localEditSequence))
        ) {
          failure = "Stored draft metadata is invalid; the existing record was kept";
          transaction.abort();
          return;
        }
        const revision = isRecord(previous) ? previous.localStorageRevision : 0;
        if (revision !== expectedRevision) {
          failure = "The local draft changed in another tab; reopen it before saving again";
          transaction.abort();
          return;
        }
        if (isRecord(previous) && editSequence < (previous.localEditSequence as number)) {
          // An older queued snapshot can arrive after a newer edit has already been saved
          failure = "A newer edit is already saved; the existing draft was kept";
          transaction.abort();
          return;
        }
        // Prepare the receipt now; return it only after the transaction commits
        receipt = {
          projectId,
          localStorageRevision: expectedRevision + 1,
          localEditSequence: editSequence,
          savedAt: new Date().toISOString(),
        };
        try {
          store.put({
            ...receipt,
            principalKey: LOCAL_PRINCIPAL,
            document: serialized.value,
            ...(history?.ok ? { history: history.value } : {}),
            baseServerRevision: null,
            pendingMutation: null,
          });
        } catch {
          transaction.abort();
        }
      };
    } catch {
      database.close();
      resolve(invalid("storage", failure));
    }
  });
}

// One active editing session, including the last manual save for dirty-state comparison
// Replacing this record discards the previous session only after the next one commits
export type RecoverySession = Readonly<{
  revision: number;
  document: ProjectDocument;
  fileName: string;
  savedJson: string | null;
  pristine: boolean;
  // Keep the chosen file with this exact session so a reload can still Save in place
  // Older records only have the filename and need one more Open to connect it
  fileHandle?: ProjectFileHandle | null;
  fileText?: string;
  history?: RecoveryHistory;
  historyWarning?: string;
}>;

export async function loadRecoverySession(
  assetKinds: ReadonlyMap<string, string>,
): Promise<ValidationResult<RecoverySession | null>> {
  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return invalid("storage", "Recovery storage could not open; your saved data was kept");
  }
  try {
    const raw: unknown = await new Promise((resolve, reject) => {
      const tx = database.transaction("session", "readonly");
      const read = tx.objectStore("session").get("active");
      tx.oncomplete = () => resolve(read.result);
      tx.onabort = () => reject(tx.error);
    });
    if (raw === undefined) return { ok: true, value: null };
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
      [
        "revision",
        "document",
        "fileName",
        "savedJson",
        "pristine",
        ...(Object.hasOwn(raw, "fileHandle") ? ["fileHandle"] : []),
        ...(Object.hasOwn(raw, "fileText") ? ["fileText"] : []),
        ...(Object.hasOwn(raw, "history") ? ["history"] : []),
      ],
      "recovery",
    );
    if (!fields.ok) return fields;
    const document = deserializeProject(raw.document, assetKinds);
    if (!document.ok) return document;
    // Keep the valid scene available even if an older history record cannot be restored
    const history =
      raw.history === undefined
        ? undefined
        : validateRecoveryHistory(raw.history, document.value, assetKinds);
    let savedJson: string | null = null;
    if (raw.savedJson !== null) {
      const saved = deserializeProject(raw.savedJson, assetKinds);
      if (!saved.ok) return saved;
      if (saved.value.projectId !== document.value.projectId)
        return invalid("storage", "Recovery file belongs to a different project");
      savedJson = JSON.stringify(saved.value);
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
      if (baseline.ok && JSON.stringify(baseline.value) === savedJson) {
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
        pristine: raw.pristine && document.value.scenes[0]?.objects.length === 0,
        fileHandle,
        fileText,
        ...(history?.ok ? { history: history.value } : {}),
        ...(history && !history.ok
          ? { historyWarning: "Scene recovered, but its undo history could not be restored" }
          : {}),
      },
    };
  } catch {
    return invalid("storage", "Recovery could not be read; the stored copy was kept");
  } finally {
    database.close();
  }
}

export async function saveRecoverySession(
  session: Omit<RecoverySession, "revision" | "historyWarning">,
  expectedRevision: number,
  assetKinds: ReadonlyMap<string, string>,
  previousProjectId?: string,
): Promise<ValidationResult<number>> {
  if (!isCounter(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER)
    return invalid("storage", "Invalid recovery revision");
  const encoded = serializeProject(session.document, assetKinds);
  if (!encoded.ok) return encoded;
  const history =
    session.history === undefined
      ? undefined
      : validateRecoveryHistory(session.history, session.document, assetKinds);
  if (history && !history.ok) return history;
  if (session.fileName.length > 255) return invalid("storage", "Project filename is too long");
  if (session.savedJson !== null) {
    const saved = deserializeProject(session.savedJson, assetKinds);
    if (!saved.ok) return saved;
    if (saved.value.projectId !== session.document.projectId)
      return invalid("storage", "Recovery file belongs to a different project");
  }
  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return invalid(
      "storage",
      "Recovery backup failed; keep this tab open and save your project file",
    );
  }
  return new Promise((resolve) => {
    let message = "Recovery backup failed; your current project is still open";
    try {
      const tx = database.transaction(["session", STORE_NAME], "readwrite");
      const store = tx.objectStore("session");
      const read = store.get("active");
      tx.onabort = () => {
        database.close();
        resolve(invalid("storage", message));
      };
      tx.oncomplete = () => {
        database.close();
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
          store.put(
            { ...session, document: encoded.value, revision: expectedRevision + 1 },
            "active",
          );
          const legacy = tx.objectStore(STORE_NAME);
          legacy.delete([LOCAL_PRINCIPAL, session.document.projectId.toLowerCase()]);
          if (previousProjectId) legacy.delete([LOCAL_PRINCIPAL, previousProjectId.toLowerCase()]);
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
      database.close();
      resolve(invalid("storage", message));
    }
  });
}
