import { isRecord, projectReceipt, type WriteResult } from "../home/workspace-api";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Write = (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>;
export const blankSourceKey = (actorId: string) => `spatia.assignment.source:${actorId}`;

export async function createBlankSource(
  storage: Store,
  write: Write,
  actorId: string,
  title: string,
  environmentAssetId: string,
): Promise<
  | { kind: "confirmed"; projectId: string; revision: number }
  | { kind: "unknown" }
  | { kind: "rejected"; message: string }
> {
  const key = blankSourceKey(actorId);
  try {
    const saved = storage.getItem(key);
    if (saved) {
      const value: unknown = JSON.parse(saved);
      if (isRecord(value) && projectReceipt(value.receipt)) {
        const receipt = value.receipt as { projectId: string; revision: number };
        return { kind: "confirmed", projectId: receipt.projectId, revision: receipt.revision };
      }
      return { kind: "unknown" };
    }
    const marker = JSON.stringify({ title, environmentAssetId });
    storage.setItem(key, marker);
    if (storage.getItem(key) !== marker)
      return { kind: "rejected", message: "The browser could not save recovery information." };
    const outcome = await write(actorId, "/api/v1/projects", "POST", { title, environmentAssetId });
    if (outcome.kind === "rejected") {
      storage.removeItem(key);
      return outcome;
    }
    if (outcome.kind !== "confirmed" || !projectReceipt(outcome.value) || !isRecord(outcome.value))
      return { kind: "unknown" };
    storage.setItem(key, JSON.stringify({ title, environmentAssetId, receipt: outcome.value }));
    return {
      kind: "confirmed",
      projectId: String(outcome.value.projectId),
      revision: Number(outcome.value.revision),
    };
  } catch {
    return { kind: "unknown" };
  }
}
