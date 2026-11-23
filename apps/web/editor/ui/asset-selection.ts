import { isRoomModel, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { furnitureTools } from "./furniture-tools";

export type AssetPickerMode = "assets" | "rooms" | "furniture";

export function belongsInAssetPicker(
  asset: CatalogueAsset,
  mode: AssetPickerMode,
  catalogue: readonly CatalogueAsset[],
): boolean {
  if (mode === "rooms") return asset.kind === "environment";
  if (asset.kind !== "model" || asset.displayRole || isRoomModel(catalogue, asset.id)) return false;
  const furniture =
    asset.category === "Furniture" || furnitureTools.some((tool) => tool.assetId === asset.id);
  return mode === "furniture" ? furniture : !furniture;
}
