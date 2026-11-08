type ProjectFileHandle = {
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(text: string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
};

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: unknown) => Promise<ProjectFileHandle>;
};

const types = [{ description: "Spatia project", accept: { "application/json": [".json"] } }];

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
  // Recheck the destination so an export cannot overwrite an intervening edit.
  if ((await (await handle.getFile()).text()) !== previousText) {
    throw new Error("This file changed outside the editor; choose a different export destination");
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
