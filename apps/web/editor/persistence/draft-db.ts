const DATABASE_NAME = "vthere-local-drafts";
const DATABASE_VERSION = 2;
const SESSION_STORE_NAME = "session";

function upgradeDatabase(database: IDBDatabase): void {
  // Keep the version-2 schema compatible with existing browser profiles and open tabs.
  if (!database.objectStoreNames.contains("drafts")) {
    database.createObjectStore("drafts", { keyPath: ["principalKey", "projectId"] });
  }
  if (!database.objectStoreNames.contains(SESSION_STORE_NAME)) {
    database.createObjectStore(SESSION_STORE_NAME);
  }
}

export interface IDraftDatabase {
  getIndexedDB(): Promise<IDBDatabase>;
}

export class IndexedDBDraftDatabase implements IDraftDatabase {
  getIndexedDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (globalThis.indexedDB === undefined) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }

      // Database version controls the store layout; project schemaVersion lives in the JSON
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => upgradeDatabase(request.result);
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
}
