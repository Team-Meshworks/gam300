import type { CatalogueAsset } from "./catalogue";

// Measured surfaces from assets/manifest.json follow immutable bytes across project and publication IDs
type Geometry = Pick<CatalogueAsset, "displayRole" | "placement" | "displaySurface" | "displayTop">;

export const displayGeometry: ReadonlyMap<string, Geometry> = new Map<string, Geometry>([
  [
    "50c2f051b5fd07fbb0e02c6b4ab7100b623dddaddf2bda918ebb86774ad441b5",
    {
      displayRole: "physical",
      placement: "bottom-center",
      displayTop: 1.2,
    },
  ],
  [
    "c9c865cff3aad313f66f26c8a5cebbbadfaf8561175820731d149c2e90d94662",
    {
      displayRole: "physical",
      placement: "bottom-center",
      displayTop: 0.2,
    },
  ],
  [
    "6e87a702862fbc3011e269ee12d090b1ec23039987367199fabf986b057c4adf",
    {
      displayRole: "physical",
      placement: "bottom-center",
      displayTop: 1.2,
    },
  ],
  [
    "c66419e457b38537f7440ef45540811e482d452842a98031a14d806b30eb527c",
    {
      displayRole: "physical",
      placement: "bottom-center",
      displayTop: 0.2,
    },
  ],
  [
    "74cdcb81fa381cf6bb7754c657a2bf1341d3db0934c732e893f79fd3d2939998",
    {
      displayRole: "digital",
      placement: "bottom-center",
      displaySurface: {
        position: [0, 1.425375, 0.05181],
        rotation: [-0.3826834324, 0, 0, 0.9238795325],
        width: 1.1,
        height: 0.63,
      },
    },
  ],
  [
    "a08937ad228596109f5e5e5670b06b95dcf923ba6dc09abc23c47dd2fcc8fc53",
    {
      displayRole: "digital",
      placement: "bottom-center",
      displaySurface: {
        position: [0, 0.5, 0.054],
        rotation: [0, 0, 0, 1],
        width: 1.92,
        height: 0.91,
      },
    },
  ],
  [
    "512419de40e96047255cd0f09aed367ce5d4ff549633d02fd607077d9ea9e2cd",
    {
      displayRole: "digital",
      placement: "bottom-center",
      displaySurface: {
        position: [0, 1.404902, 0.064541],
        rotation: [-0.3826834324, 0, 0, 0.9238795325],
        width: 0.61,
        height: 0.61,
      },
    },
  ],
  [
    "fdd9139e74ba98d5a1eee8652076353130ba51bbfafb7528c7e71c42c965f167",
    {
      displayRole: "digital",
      placement: "bottom-center",
      displaySurface: {
        position: [0, 0.5, 0.054],
        rotation: [0, 0, 0, 1],
        width: 0.91,
        height: 0.91,
      },
    },
  ],
]);
