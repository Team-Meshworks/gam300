import { knownRoomGeometry, type CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { deserializeProject, readProjectJson } from "../shared/project/project-deserialization";
import { missingProjectCapabilities } from "../shared/project/project-capabilities";
import capabilities from "../shared/project/publication-capabilities.json";
import { readOlderSceneFile } from "../shared/project/legacy-scene-import";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const assetId = (value: unknown): value is string =>
  id(value) || (typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value));
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
      !assetId(asset.id) ||
      seen.has(asset.id) ||
      (asset.kind !== "model" &&
        asset.kind !== "environment" &&
        asset.kind !== "audio" &&
        asset.kind !== "image" &&
        asset.kind !== "video") ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      asset.url !== `/api/v1/publications/${publicationId}/assets/${asset.id}/bytes`
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
      // Match the editor's approved-room origin using metadata bound to the exact digest
      ...(knownRoomGeometry[asset.sha256]
        ? { boundsMeters: knownRoomGeometry[asset.sha256], placement: "bottom-center" as const }
        : {}),
    };
  });
  return { projectId: value.projectId, sourceRevision: Number(value.sourceRevision), assets };
}

export async function loadPublication(publicationId: string, signal: AbortSignal) {
  const options = { signal, credentials: "same-origin", cache: "no-store" } as const;
  const [metadata, snapshot] = await Promise.all([
    fetch(`/api/v1/publications/${publicationId}/manifest`, options),
    fetch(`/api/v1/publications/${publicationId}`, options),
  ]);
  if (!metadata.ok || !snapshot.ok)
    throw new Error("This exhibition is unavailable or your account does not have access.");
  const manifest = readPublicationManifest(await metadata.json(), publicationId);

  // Read the version before choosing its validator; keep older publications in their original format
  const text = await snapshot.text();
  const json = readProjectJson(text);
  const kinds = new Map(manifest.assets.map((asset) => [asset.id, asset.kind]));
  const version =
    json.ok && typeof json.value === "object" && json.value !== null
      ? (json.value as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  const parsed = version === 2 ? deserializeProject(text, kinds) : readOlderSceneFile(text, kinds);
  if (!parsed.ok || parsed.value.projectId.toLowerCase() !== manifest.projectId.toLowerCase()) {
    throw new Error("This exhibition format is not supported.");
  }

  // Check playback support after validation so saved rules and content stay intact
  // The server reads this same capability list before creating a publication
  if (parsed.value.schemaVersion === 2) {
    const missing = missingProjectCapabilities(parsed.value, new Set(capabilities));
    if (missing.length) {
      throw new Error(
        `This exhibition requires unsupported features: ${missing.map((issue) => `${issue.capability} at ${issue.path}`).join(", ")}`,
      );
    }
  }
  // URL-only audio has no immutable manifest entry; require a captured audio component instead
  if (
    parsed.value.scenes.some(
      (scene) =>
        "interactions" in scene &&
        scene.interactions.some(
          (item) => item.do.type === "play-audio" && item.do.url !== undefined,
        ),
    )
  ) {
    throw new Error("This exhibition audio must use an approved library track.");
  }
  return { ...manifest, document: parsed.value };
}
export type PublishedExhibition = Awaited<ReturnType<typeof loadPublication>>;
