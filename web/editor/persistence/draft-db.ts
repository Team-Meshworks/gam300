import { invalid, type ValidationResult } from "../../shared/project/validation-helpers";
import { singletonIDBConnection } from "./idb-database-connection";

export interface IDraftDatabase {
    getDraft(projectId: string): Promise<ValidationResult<unknown>>;
    getIndexedDB(): Promise<IDBDatabase>;
}

export class IndexedDBDraftDatabase implements IDraftDatabase {
    readonly STORE_NAME = "drafts";
    readonly LOCAL_PRINCIPAL = "local";

    async getDraft(projectId: string): Promise<ValidationResult<unknown>> {
        const database = await singletonIDBConnection.openDatabase(this.STORE_NAME);
        const stored = await new Promise<ValidationResult<unknown>>((resolve) => {
        try {
            // Read-only transaction keeps failed recovery from changing the stored copy
            const transaction = database.transaction(this.STORE_NAME, "readonly");
            const read = transaction
                .objectStore(this.STORE_NAME)
                .get([this.LOCAL_PRINCIPAL, projectId.toLowerCase()]);
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

    async getIndexedDB(): Promise<IDBDatabase> {
        return await singletonIDBConnection.openDatabase(this.STORE_NAME);
    }
}
