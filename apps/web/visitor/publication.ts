import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { readOlderSceneFile } from "../shared/project/legacy-scene-import";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
export function readPublicationManifest(value: unknown, publicationId: string) {
  if (
    !record(value) ||
    !id(publicationId) ||
    value.publicationId !== publicationId ||
    !id(value.projectId) ||
    !Number.isSafeInteger(value.sourceRevision) ||
    Number(value.sourceRevision) < 0 ||
    !Array.isArray(value.assets)
  )
    throw new Error("The exhibition could not be verified.");
  const seen = new Set<string>();
  const assets: CatalogueAsset[] = value.assets.map((asset: unknown) => {
    if (
      !record(asset) ||
      !id(asset.id) ||
      seen.has(asset.id) ||
      (asset.kind !== "model" && asset.kind !== "environment") ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      asset.url !== `/api/publications/${publicationId}/assets/${asset.id}/bytes`
    )
      throw new Error("The exhibition assets could not be verified.");
    seen.add(asset.id);
    return {
      id: asset.id,
      kind: asset.kind,
      name: "Exhibition asset",
      url: String(asset.url),
      sha256: asset.sha256,
      thumbnail: null,
    };
  });
  return { projectId: value.projectId, sourceRevision: Number(value.sourceRevision), assets };
}

export async function loadPublication(publicationId: string, signal: AbortSignal) {
  const options = { signal, credentials: "same-origin", cache: "no-store" } as const;
  const [metadata, snapshot] = await Promise.all([
    fetch(`/api/publications/${publicationId}/manifest`, options),
    fetch(`/api/publications/${publicationId}`, options),
  ]);
  if (!metadata.ok || !snapshot.ok)
    throw new Error("This exhibition is unavailable or your account does not have access.");
  const manifest = readPublicationManifest(await metadata.json(), publicationId);
  const parsed = readOlderSceneFile(
    await snapshot.text(),
    new Map(manifest.assets.map((asset) => [asset.id, asset.kind])),
  );
  if (!parsed.ok || parsed.value.projectId.toLowerCase() !== manifest.projectId.toLowerCase())
    throw new Error("This exhibition format is not supported.");
  return { ...manifest, document: parsed.value };
}
export type PublishedExhibition = Awaited<ReturnType<typeof loadPublication>>;
