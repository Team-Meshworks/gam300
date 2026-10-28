import type { CatalogueAsset } from "./catalogue";

export const HOTSPOT_ASSET_ID = "hotspot-v1";

export const HOTSPOT_ASSET: CatalogueAsset = Object.freeze({
  id: HOTSPOT_ASSET_ID,
  name: "Hotspot",
  kind: "model",
  url: "/icons/hotspot.svg",
  sha256: "27feb4bf0cc5af9cd1fece6b2a5cfa46ecc0037b6a8b385c409566f0b67ef5cd",
  thumbnail: "/icons/hotspot.svg",
});
