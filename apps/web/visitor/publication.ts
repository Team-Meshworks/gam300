import { displayGeometry } from "../shared/asset-runtime/catalogue";
import { knownRoomGeometry, type CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { deserializeProject, readProjectJson } from "../shared/project/project-deserialization";
import { playbackIssue } from "../shared/player/player-snapshot";
import { readOlderSceneFile } from "../shared/project/legacy-scene-import";

const record = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: string): boolean =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const assetId = (value: unknown): value is string =>
  typeof value === "string" && (id(value) || /^[a-z0-9][a-z0-9-]{0,127}$/.test(value));
export function readPublicationManifest(value: unknown, publicationId: string) {
  if (
    !record(value) ||
    !id(publicationId) ||
    !("publicationId" in value) ||
    value.publicationId !== publicationId ||
    !("projectId" in value) ||
    typeof value.projectId !== "string" ||
    !id(value.projectId) ||
    !("sourceRevision" in value) ||
    typeof value.sourceRevision !== "number" ||
    !Number.isSafeInteger(value.sourceRevision) ||
    value.sourceRevision < 0 ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  )
    throw new Error("The exhibition could not be verified.");
  const seen = new Set<string>();
  const assets: CatalogueAsset[] = value.assets.map((asset: unknown) => {
    const placement = record(asset) && "placement" in asset ? asset.placement : undefined;
    const nonBlocking = record(asset) && "nonBlocking" in asset ? asset.nonBlocking : undefined;
    if (
      !record(asset) ||
      !("id" in asset) ||
      !assetId(asset.id) ||
      seen.has(asset.id) ||
      !("kind" in asset) ||
      (asset.kind !== "model" &&
        asset.kind !== "environment" &&
        asset.kind !== "audio" &&
        asset.kind !== "image" &&
        asset.kind !== "video") ||
      (placement !== undefined && placement !== null && placement !== "bottom-center") ||
      (placement === "bottom-center" && asset.kind !== "model" && asset.kind !== "environment") ||
      (nonBlocking !== undefined && typeof nonBlocking !== "boolean") ||
      (nonBlocking === true && asset.kind !== "model") ||
      !("sha256" in asset) ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !("url" in asset) ||
      asset.url !== `/api/v1/publications/${publicationId}/assets/${asset.id}/bytes`
    )
      throw new Error("The exhibition assets could not be verified.");
    seen.add(asset.id);
    const boundsMeters = knownRoomGeometry.get(asset.sha256);
    return {
      id: asset.id,
      kind: asset.kind,
      name: "Exhibition asset",
      url: asset.url,
      sha256: asset.sha256,
      thumbnail: null,
      ...(asset.kind === "model" ? displayGeometry.get(asset.sha256) : undefined),
      ...(nonBlocking === true ? { nonBlocking: true as const } : {}),
      ...(placement === "bottom-center" ? { placement } : {}),
      // Match the editor's approved-room origin using metadata bound to the exact digest
      ...(boundsMeters ? { boundsMeters, placement: "bottom-center" as const } : {}),
    };
  });
  return { projectId: value.projectId, sourceRevision: value.sourceRevision, assets };
}

export async function loadPublication(
  publicationId: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const options = { signal, credentials: "same-origin", cache: "no-store" } as const;
  const [metadata, snapshot] = await Promise.all([
    request(`/api/v1/publications/${publicationId}/manifest`, options),
    request(`/api/v1/publications/${publicationId}`, options),
  ]);
  if (!metadata.ok || !snapshot.ok)
    throw new Error("This exhibition is unavailable or your account does not have access.");
  const manifest = readPublicationManifest(await metadata.json(), publicationId);

  // Read the version before choosing its validator; keep older publications in their original format
  const text = await snapshot.text();
  signal.throwIfAborted();
  const json = readProjectJson(text);
  const kinds = new Map(manifest.assets.map((asset) => [asset.id, asset.kind]));
  const version =
    json.ok && record(json.value) && "schemaVersion" in json.value
      ? json.value.schemaVersion
      : undefined;
  const current = deserializeProject(text, kinds);
  const parsed = !current.ok && version === 1 ? readOlderSceneFile(text, kinds) : current;
  if (!parsed.ok || parsed.value.projectId.toLowerCase() !== manifest.projectId.toLowerCase()) {
    throw new Error("This exhibition format is not supported.");
  }

  const issue = playbackIssue(parsed.value);
  if (issue) throw new Error(issue);
  return { ...manifest, document: parsed.value };
}
export type PublishedExhibition = Awaited<ReturnType<typeof loadPublication>>;
