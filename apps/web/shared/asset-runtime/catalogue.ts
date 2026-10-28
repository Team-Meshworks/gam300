export type CatalogueAsset = Readonly<{
  id: string;
  name: string;
  kind: "environment" | "model";
  url: string;
  sha256: string;
  thumbnail: string | null;
  placement?: "bottom-center";
  room?: { width: number; depth: number; environmentAssetId?: string };
}>;

export const assetDragType = "application/x-vthere-asset";
