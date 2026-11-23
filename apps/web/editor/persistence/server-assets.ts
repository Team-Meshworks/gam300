import { displayGeometry } from "../../shared/asset-runtime/catalogue";
import { combineAbortSignals } from "../../shared/network/abort-signals";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { knownRoomGeometry } from "../../shared/asset-runtime/catalogue";
import { isRecord, readField } from "../../shared/project/validation-helpers";

export async function readServerAssets(
  accountId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  projectId?: string,
): Promise<readonly CatalogueAsset[]> {
  if (projectId !== undefined && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectId))
    throw new Error("Invalid project identity.");
  const path = projectId ? `/api/v1/projects/${projectId}/assets` : "/api/v1/assets";
  const response = await fetcher(path, {
    headers: { "X-Spatia-Account": accountId },
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: combineAbortSignals([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok)
    throw new Error("Approved assets could not be loaded. Retry opening this project.");
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || rows.length > 100_000)
    throw new Error("Invalid approved asset catalogue.");
  const seen = new Set<string>();
  return rows.map((row: unknown) => {
    if (!isRecord(row)) throw new Error("Invalid approved asset catalogue.");
    const id = readField(row, "id");
    const name = readField(row, "name");
    const kind = readField(row, "kind");
    const url = readField(row, "url");
    const sha256 = readField(row, "sha256");
    const category = readField(row, "category");
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ||
      seen.has(id.toLowerCase()) ||
      typeof name !== "string" ||
      !name.trim() ||
      (kind !== "environment" &&
        kind !== "model" &&
        kind !== "image" &&
        kind !== "video" &&
        kind !== "audio") ||
      url !== `${path}/${id}/bytes` ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(sha256) ||
      (category !== null && typeof category !== "string") ||
      readField(row, "thumbnail") !== null
    )
      throw new Error("Invalid approved asset catalogue.");
    seen.add(id.toLowerCase());
    const measured =
      kind === "environment" || kind === "model"
        ? knownRoomGeometry.get(sha256.toLowerCase())
        : undefined;
    return {
      id,
      name,
      kind,
      url,
      sha256,
      thumbnail: null,
      ...(kind === "model" ? displayGeometry.get(sha256.toLowerCase()) : undefined),
      ...(measured ? { boundsMeters: measured, placement: "bottom-center" as const } : {}),
      ...(typeof category === "string" ? { category } : {}),
    };
  });
}
