declare module "virtual:asset-catalogue" {
  export const packaged: boolean;
  export const assets: readonly import("./catalogue").CatalogueAsset[];
}
