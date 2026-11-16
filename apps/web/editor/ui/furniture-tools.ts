import type { IconName } from "./Icon";

// Built-in furniture remains identifiable when a catalogue record omits its category.
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
