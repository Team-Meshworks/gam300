import { isStarterRoomModelAsset, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { furnitureTools } from "./furniture-tools";

// Match the editor's two pickers, including assets supplied by the approved catalogue.
export function belongsInAssetPicker(asset: CatalogueAsset, rooms: boolean): boolean {
  return rooms
    ? asset.kind === "environment"
    : asset.kind === "model" &&
        !isStarterRoomModelAsset(asset) &&
        !asset.displayRole &&
        !furnitureTools.some((tool) => tool.assetId === asset.id);
}
