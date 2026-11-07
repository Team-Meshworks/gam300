// Small surface shared by native file handles and our browser checks
// Permission prompts belong to an explicit Open or Save click, never a background timer
export type ProjectFileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  createWritable(options: { mode: "exclusive" }): Promise<{
    write(text: string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
};

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options: unknown) => Promise<ProjectFileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<ProjectFileHandle>;
};

const types = [{ description: "Spatia project", accept: { "application/json": [".json"] } }];

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
  return `spatia-${name || "project"}.json`;
}

export function wasPickerCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function writeProjectFile(
  handle: ProjectFileHandle,
  text: string,
  previousText: string,
): Promise<void> {
  // Hold the browser's writer lock before checking the baseline so two saves cannot both pass
  const stream = await handle.createWritable({ mode: "exclusive" });
  try {
    if ((await (await handle.getFile()).text()) !== previousText) {
      throw new Error("This file changed outside the editor; reopen it or use Save As");
    }
    await stream.write(text);
    // Closing commits the temporary write; writing bytes alone doesn't confirm a saved file
    await stream.close();
  } catch (error) {
    // Discard the unfinished write while keeping the original failure for the caller
    await stream.abort().catch(() => undefined);
    throw error;
  }
}
