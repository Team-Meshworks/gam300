import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { isRecord } from "../../shared/project/validation-helpers";

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
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok)
    throw new Error("Approved assets could not be loaded. Retry opening this project.");
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || rows.length > (projectId ? 100_000 : 1000))
    throw new Error("Invalid approved asset catalogue.");
  const seen = new Set<string>();
  return rows.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(row.id) ||
      seen.has(row.id.toLowerCase()) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      !["environment", "model", "image", "video", "audio"].includes(String(row.kind)) ||
      row.url !== `${path}/${row.id}/bytes` ||
      typeof row.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(row.sha256) ||
      (row.category !== null && typeof row.category !== "string") ||
      row.thumbnail !== null
    )
      throw new Error("Invalid approved asset catalogue.");
    seen.add(row.id.toLowerCase());
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as CatalogueAsset["kind"],
      url: row.url as string,
      sha256: row.sha256,
      thumbnail: null,
      ...(typeof row.category === "string" ? { category: row.category } : {}),
    };
  });
}
