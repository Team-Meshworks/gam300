// Approved 3D categories are shared by filtering and its consuming picker
export const assetCategories = [
  "All",
  "Objects",
  "Furniture",
  "Architecture",
  "Clothing",
  "Tools & Equipment",
] as const;

export type CatalogueAsset = Readonly<{
  id: string;
  name: string;
  kind: "environment" | "model" | "image" | "video" | "audio";
  url: string;
  sha256: string;
  thumbnail: string | null;
  placement?: "bottom-center";
  // Measured source bounds; normalized environments use their size for the initial overview.
  boundsMeters?: Readonly<{
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }>;
  displayRole?: "physical" | "digital";
  category?: string;
  durationSeconds?: number;
  // Local coordinates after bottom-center model normalization, in metres.
  displayTop?: number;
  displaySurface?: Readonly<{
    position: readonly [number, number, number];
    rotation: readonly [number, number, number, number];
    width: number;
    height: number;
  }>;
}>;

// This geometry has known ten-metre footprints and named walls for adjoining doors.
export const STARTER_ROOM_SHA256 =
  "121c9d86eefb1961a697a390967dfeface3ce1f612334d2fbc447551ddfd88d1";

export function isStarterRoomModelAsset(asset: CatalogueAsset) {
  return (
    asset.kind === "model" &&
    (asset.id === "test-room-module-v1" || asset.sha256.toLowerCase() === STARTER_ROOM_SHA256)
  );
}

export function isStarterRoomModel(assets: readonly CatalogueAsset[], id: string | undefined) {
  return (
    id === "test-room-module-v1" ||
    assets.some((asset) => asset.id === id && isStarterRoomModelAsset(asset))
  );
}

// New room instances may use only a model in the selectable catalogue.
export function starterRoomCompanion(assets: readonly CatalogueAsset[]) {
  return (
    assets.find((asset) => asset.id === "test-room-module-v1" && isStarterRoomModelAsset(asset)) ??
    assets.find(isStarterRoomModelAsset)
  );
}

// Match server identities only when they refer to the known packaged room geometry.
export function isStarterRoomEnvironment(
  assets: readonly CatalogueAsset[],
  id: string | undefined,
) {
  if (id === "test-room-v1") return true;
  const environment = assets.find((asset) => asset.id === id && asset.kind === "environment");
  return !!environment && environment.sha256.toLowerCase() === STARTER_ROOM_SHA256;
}

export const assetDragType = "application/x-vthere-asset";

// Keep the catalogue order and asset IDs used by placement
// Match literal text so search never evaluates user-supplied patterns
export function searchAssets(
  assets: readonly CatalogueAsset[],
  query: string,
  category: string = "All",
) {
  const name = query.trim().toLowerCase();
  // Apply name and category together while preserving asset identity and catalogue order
  return assets.filter(
    (asset) =>
      (category === "All" || asset.category === category) &&
      asset.name.toLowerCase().includes(name),
  );
}
