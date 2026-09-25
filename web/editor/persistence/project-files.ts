// Small surface shared by native file handles and our browser checks
// Permission prompts belong to an explicit Open or Save click, never a background timer
export type ProjectFileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  createWritable(): Promise<{
    write(text: string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
};

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options: unknown) => Promise<ProjectFileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<ProjectFileHandle>;
};

const types = [{ description: "VThere project", accept: { "application/json": [".json"] } }];

export function canPickProjectFiles(): boolean {
  const browser = window as FilePickerWindow;
  return (
    typeof browser.showOpenFilePicker === "function" &&
    typeof browser.showSaveFilePicker === "function"
  );
}

export async function pickProjectFile(): Promise<ProjectFileHandle | undefined> {
  return (await (window as FilePickerWindow).showOpenFilePicker?.({ types, multiple: false }))?.[0];
}

export async function pickProjectDestination(name: string): Promise<ProjectFileHandle | undefined> {
  return (window as FilePickerWindow).showSaveFilePicker?.({ types, suggestedName: name });
}

// Suggested filename only; the picker still lets the author rename it
// Prefix keeps empty titles and reserved names away from the bare filename
export function projectFilename(title: string): string {
  const name = title
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `vthere-${name || "project"}.json`;
}

export function wasPickerCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function writeProjectFile(
  handle: ProjectFileHandle,
  text: string,
  previousText: string,
): Promise<void> {
  // A second editor or another application may have changed the file since we opened it
  // Refuse a stale overwrite even when the browser still grants write permission
  if ((await (await handle.getFile()).text()) !== previousText) {
    throw new Error("This file changed outside the editor; reopen it or use Save As");
  }
  const stream = await handle.createWritable();
  try {
    await stream.write(text);
    // Closing commits the temporary write; writing bytes alone doesn't confirm a saved file
    await stream.close();
  } catch (error) {
    // Discard the unfinished write while keeping the original failure for the caller
    await stream.abort().catch(() => undefined);
    throw error;
  }
}

type FileLink = { projectId: string; name: string; text: string };

// Remember only the filename and written text alongside the recovery project
// Reopening reconnects through the picker; native handles stay inside this session
async function openLinks(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("vthere-project-files", 1);
    let blocked = false;
    request.onupgradeneeded = () =>
      request.result.createObjectStore("links", { keyPath: "projectId" });
    // Another tab may still hold an older connection
    // Reject now and close any connection that arrives after this attempt has ended
    request.onblocked = () => {
      blocked = true;
      reject(new Error("File links are unavailable"));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export async function rememberProjectFile(
  projectId: string,
  handle: ProjectFileHandle | null,
  text = "",
): Promise<void> {
  const database = await openLinks();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("links", "readwrite");
      const store = transaction.objectStore("links");
      // A plain file upload has no writable destination to reconnect later
      if (handle === null) store.delete(projectId.toLowerCase());
      else store.put({ projectId: projectId.toLowerCase(), name: handle.name, text });
      // Report success after the whole transaction commits
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function recallProjectFile(projectId: string): Promise<FileLink | null> {
  const database = await openLinks();
  try {
    const link = await new Promise<FileLink | undefined>((resolve, reject) => {
      const transaction = database.transaction("links", "readonly");
      const read = transaction.objectStore("links").get(projectId.toLowerCase());
      transaction.oncomplete = () => resolve(read.result as FileLink | undefined);
      transaction.onabort = () => reject(transaction.error);
    });
    // Stored metadata can outlive the code that wrote it
    // Ignore incomplete entries and let Save ask for a destination again
    if (
      !link ||
      link.projectId !== projectId.toLowerCase() ||
      typeof link.text !== "string" ||
      typeof link.name !== "string"
    )
      return null;
    return link;
  } finally {
    database.close();
  }
}
