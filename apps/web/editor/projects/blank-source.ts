import type { EncodedProjectImage } from "./project-image";
import { isRecord, projectReceipt, type WriteResult } from "../home/workspace-api";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Write = (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>;
type ReadSource = (
  actorId: string,
  projectId: string,
) => Promise<{ kind: "available"; revision: number } | { kind: "unavailable" } | { kind: "retry" }>;
export const blankSourceKey = (actorId: string) => `spatia.assignment.source:${actorId}`;

export async function createBlankSource(
  storage: Store,
  write: Write,
  actorId: string,
  title: string,
  environmentAssetId: string,
  readSource: ReadSource,
  image?: EncodedProjectImage,
): Promise<
  | { kind: "confirmed"; projectId: string; revision: number }
  | { kind: "unknown" }
  | { kind: "source-unavailable" }
  | { kind: "image-mismatch" }
  | { kind: "rejected"; message: string }
> {
  const key = blankSourceKey(actorId);
  try {
    const imageKey = image
      ? Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(image))),
          ),
        )
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("")
      : undefined;
    const saved = storage.getItem(key);
    if (saved) {
      const value: unknown = JSON.parse(saved);
      if (isRecord(value) && projectReceipt(value.receipt)) {
        if (value.imageKey !== imageKey) return { kind: "image-mismatch" };
        const receipt = value.receipt as { projectId: string; revision: number };
        const current = await readSource(actorId, receipt.projectId);
        if (current.kind === "unavailable") return { kind: "source-unavailable" };
        if (current.kind === "retry")
          return {
            kind: "rejected",
            message: "The source project could not be checked. Try again.",
          };
        return { kind: "confirmed", projectId: receipt.projectId, revision: current.revision };
      }
      return { kind: "unknown" };
    }
    const marker = JSON.stringify({ title, environmentAssetId, ...(imageKey ? { imageKey } : {}) });
    storage.setItem(key, marker);
    if (storage.getItem(key) !== marker)
      return { kind: "rejected", message: "The browser could not save recovery information." };
    const outcome = await write(actorId, "/api/v1/projects", "POST", {
      title,
      ...(environmentAssetId ? { environmentAssetId } : {}),
      ...(image ? { image } : {}),
    });
    if (outcome.kind === "rejected") {
      storage.removeItem(key);
      return outcome;
    }
    if (outcome.kind !== "confirmed" || !projectReceipt(outcome.value) || !isRecord(outcome.value))
      return { kind: "unknown" };
    storage.setItem(
      key,
      JSON.stringify({
        title,
        environmentAssetId,
        ...(imageKey ? { imageKey } : {}),
        receipt: outcome.value,
      }),
    );
    return {
      kind: "confirmed",
      projectId: String(outcome.value.projectId),
      revision: Number(outcome.value.revision),
    };
  } catch {
    return { kind: "unknown" };
  }
}
