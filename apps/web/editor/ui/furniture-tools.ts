import type { IconName } from "./Icon";

// Furniture models use the compact toolbar picker, separate from the asset library
export const furnitureTools = [
  {
    label: "Modern bench 1",
    icon: "bench",
    assetId: "furniture-modern-bench-1-v1",
  },
  {
    label: "Modern bench 2",
    icon: "bench",
    assetId: "furniture-modern-bench-2-v1",
  },
] satisfies { label: string; icon: IconName; assetId: string }[];
