import { deserializeProject } from "../../shared/project/project-deserialization";
import { serializeProject } from "../../shared/project/project-serialization";
import type { RecoveredDraft } from "./local-drafts";
import { isPristineLocalProject, type RecoverySession } from "./recovery-session";

export async function recoverLegacyLocalDraft(
  draft: RecoveredDraft,
  assetKinds: ReadonlyMap<string, string>,
): Promise<RecoverySession> {
  const link = await recallProjectFile(draft.projectId).catch(() => null);
  let baseline: string | null = null;
  if (link) {
    const checked = deserializeProject(link.text, assetKinds);
    if (checked.ok && checked.value.projectId === draft.document.projectId) {
      const encoded = serializeProject(checked.value, assetKinds);
      if (encoded.ok) baseline = encoded.value;
    }
  }
  return {
    revision: 0,
    document: draft.document,
    fileName: link?.name ?? "",
    savedJson: baseline,
    pristine: !link && isPristineLocalProject(draft.document),
    ...(draft.history ? { history: draft.history } : {}),
    ...(draft.historyWarning ? { historyWarning: draft.historyWarning } : {}),
  };
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

async function recallProjectFile(projectId: string): Promise<FileLink | null> {
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
