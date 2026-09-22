import { serializeProject } from "../../shared/project/project-serialization";
import { invalid, isRecord } from "../../shared/project/validation-helpers";
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
