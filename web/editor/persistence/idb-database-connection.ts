const DATABASE_NAME = "vthere-local-drafts";
const DATABASE_VERSION = 2;
const SESSION_STORE_NAME = "session";

function upgradeDatabase(database: IDBDatabase, storeName: string): void {
    // Keep the local namespace separate from future signed-in account records
    if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: ["principalKey", "projectId"] });
    }
    if (!database.objectStoreNames.contains(SESSION_STORE_NAME)) {
        database.createObjectStore(SESSION_STORE_NAME);
    }
}

export class IndexedDBConnection {
    public openDatabase(storeName: string): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            if (globalThis.indexedDB === undefined) {
                reject(new Error("IndexedDB is unavailable"));
                return;
            }

            // Database version controls the store layout; project schemaVersion lives in the JSON
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            let blocked = false;
            request.onupgradeneeded = () => upgradeDatabase(request.result, storeName);
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

    public closeDatabase(database: IDBDatabase): void {
        database.close();
    }

    
}

export const singletonIDBConnection = new IndexedDBConnection();
