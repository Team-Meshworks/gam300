import { isRoomModel, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { furnitureTools } from "./furniture-tools";

// Match the editor's two pickers, including assets supplied by the approved catalogue.
export function belongsInAssetPicker(
  asset: CatalogueAsset,
  rooms: boolean,
  catalogue: readonly CatalogueAsset[],
): boolean {
  return rooms
    ? asset.kind === "environment"
    : asset.kind === "model" &&
        !isRoomModel(catalogue, asset.id) &&
        !asset.displayRole &&
        !furnitureTools.some((tool) => tool.assetId === asset.id);
}
