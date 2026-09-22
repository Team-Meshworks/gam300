import { serializeProject } from "../../shared/project/project-serialization";
import { deserializeProject } from "../../shared/project/project-deserialization";
import type { ProjectDocument } from "../../shared/project/project-types";
import { checkFields, invalid, isRecord } from "../../shared/project/validation-helpers";
import type { ValidationResult } from "../../shared/project/validation-helpers";

const DATABASE_NAME = "vthere-local-drafts";
const STORE_NAME = "drafts";
const LOCAL_PRINCIPAL = "local";

type SaveRequest = Readonly<{
  project: unknown;
  expectedStorageRevision: number;
  localEditSequence: number;
}>;

type SaveReceipt = Readonly<{
  projectId: string;
  localStorageRevision: number;
  localEditSequence: number;
  savedAt: string;
}>;

type RecoveredDraft = SaveReceipt & Readonly<{ document: ProjectDocument }>;

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (globalThis.indexedDB === undefined) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      // Keep the local namespace separate from future signed-in account records
      request.result.createObjectStore(STORE_NAME, { keyPath: ["principalKey", "projectId"] });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Another tab is holding the database open"));
    };
    request.onsuccess = () => {
      const database = request.result;
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
    ],
    "storage",
  );
  if (!fields.ok) return fields;
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
    return invalid("storage.projectId", "Stored document belongs to a different project");
  }
  return {
    ok: true,
    value: {
      projectId,
      document: document.value,
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
      const transaction = database.transaction(STORE_NAME, "readonly");
      const read = transaction
        .objectStore(STORE_NAME)
        .get([LOCAL_PRINCIPAL, projectId.toLowerCase()]);
      transaction.oncomplete = () => {
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
  const checked: { projectId: string } = JSON.parse(serialized.value);
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
          failure = "A newer edit is already saved; the existing draft was kept";
          transaction.abort();
          return;
        }
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
