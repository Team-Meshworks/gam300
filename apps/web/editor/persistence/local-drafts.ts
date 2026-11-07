import { serializeProject } from "../../shared/project/project-serialization";
import { deserializeProject } from "../../shared/project/project-deserialization";
import type { ProjectDocument } from "../../shared/project/project-types";
import { checkFields, invalid, isRecord } from "../../shared/project/validation-helpers";
import type { ValidationResult } from "../../shared/project/validation-helpers";
import { validateRecoveryHistory, type RecoveryHistory } from "../recovery-history";
import {
  IndexedDBDraftDatabase,
  DRAFT_STORE_NAME as STORE_NAME,
  LOCAL_PRINCIPAL,
  isCounter,
  type IDraftDatabase,
} from "./draft-db";

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

export type RecoveredDraft = SaveReceipt &
  Readonly<{
    document: ProjectDocument;
    history?: RecoveryHistory;
    historyWarning?: string;
    recoveryWarning?: string;
  }>;

function validateStoredDraft(
  raw: unknown,
  projectId: string,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<RecoveredDraft | null> {
  // A missing draft is a normal first visit
  // Damaged records return an error and stay available for recovery
  if (raw === undefined) {
    return { ok: true, value: null };
  }
  if (!isRecord(raw)) {
    return invalid("storage", "Stored draft must be an object");
  }
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
  if (!fields.ok) {
    return fields;
  }

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
  if (!document.ok) {
    return document;
  }
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

async function readStoredDraft(
  projectId: string,
  connection: IDraftDatabase,
): Promise<ValidationResult<unknown>> {
  let database: IDBDatabase;
  try {
    database = await connection.getIndexedDB();
  } catch {
    return invalid("storage", "Local draft could not be read; try again");
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
  return stored;
}

// Return a checked draft for the caller to offer to the author
// Reading never replaces the live project or deletes a rejected record
export async function loadLocalDraft(
  projectId: string,
  assetKinds: ReadonlyMap<string, string>,
): Promise<ValidationResult<RecoveredDraft | null>> {
  return await getLocalDraft(projectId, assetKinds, new IndexedDBDraftDatabase());
}

export async function getLocalDraft(
  projectId: string,
  assetKinds: ReadonlyMap<string, string>,
  database: IDraftDatabase,
): Promise<ValidationResult<RecoveredDraft | null>> {
  if (
    typeof projectId !== "string" ||
    projectId.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)
  ) {
    return invalid("storage.projectId", "Expected a project UUID");
  }

  const stored = await readStoredDraft(projectId.toLowerCase(), database);
  if (!stored.ok) {
    return stored;
  }
  return validateStoredDraft(stored.value, projectId.toLowerCase(), assetKinds);
}

// On a fresh page there is no project ID yet; offer the most recently saved local project
export async function loadLatestLocalDraft(
  assetKinds: ReadonlyMap<string, string>,
): Promise<ValidationResult<RecoveredDraft | null>> {
  return await getLatestLocalDraft(assetKinds, new IndexedDBDraftDatabase());
}

export async function getLatestLocalDraft(
  assetKinds: ReadonlyMap<string, string>,
  database: IDraftDatabase,
): Promise<ValidationResult<RecoveredDraft | null>> {
  let connection: IDBDatabase;
  try {
    connection = await database.getIndexedDB();
  } catch {
    return invalid("storage", "Local storage could not open; the current project is unchanged");
  }
  return new Promise<ValidationResult<RecoveredDraft | null>>((resolve) => {
    try {
      const transaction = connection.transaction(STORE_NAME, "readonly");
      const read = transaction.objectStore(STORE_NAME).openCursor();
      let record: RecoveredDraft | null = null;
      let latestTime = -Infinity;
      let damaged = false;
      read.onsuccess = () => {
        const cursor = read.result;
        if (cursor === null) {
          return;
        }
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
        connection.close();
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
        connection.close();
        resolve(invalid("storage", "Local drafts could not be read; try again"));
      };
    } catch {
      connection.close();
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
  return await applySaveToLocalDraft(request, assetKinds, new IndexedDBDraftDatabase());
}

export async function applySaveToLocalDraft(
  request: SaveRequest,
  assetKinds: ReadonlyMap<string, string>,
  database: IDraftDatabase,
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
  if (!serialized.ok) {
    return serialized;
  }
  const checked: ProjectDocument = JSON.parse(serialized.value);
  const history =
    request.history === undefined
      ? undefined
      : validateRecoveryHistory(request.history, checked, assetKinds);
  if (history !== undefined && !history.ok) {
    return history;
  }

  // UUID letter case must resolve to the same draft key
  // Original spelling stays inside the saved JSON
  const projectId = checked.projectId.toLowerCase();
  const expectedRevision = request.expectedStorageRevision;
  const editSequence = request.localEditSequence;
  let connection: IDBDatabase;
  try {
    connection = await database.getIndexedDB();
  } catch {
    return invalid("storage", "Local storage could not open; keep this tab open and try again");
  }

  return new Promise((resolve) => {
    let failure = "Local save failed; the current project is still in memory";
    let receipt: SaveReceipt | undefined;
    try {
      const transaction = connection.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      transaction.onabort = () => {
        connection.close();
        resolve(invalid("storage", failure));
      };
      transaction.oncomplete = () => {
        connection.close();

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
      connection.close();
      resolve(invalid("storage", failure));
    }
  });
}
