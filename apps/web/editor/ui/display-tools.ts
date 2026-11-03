import type { IconName } from "./Icon";

export type DisplayTool = { label: string; icon: IconName; assetId: string };

// Keep each supplied model paired with its own existing toolbar silhouette.
// The reference's fourth portrait panel has no supplied GLB and is not offered.
export const displayPanelTools = [
  {
    label: "Landscape media stand",
    icon: "panelStanding",
    assetId: "display-rectangle-stand-v1",
  },
  { label: "Square media stand", icon: "panelSmall", assetId: "display-square-stand-v1" },
  {
    label: "Landscape media panel",
    icon: "panelLandscape",
    assetId: "display-rectangle-panel-v1",
  },
] satisfies [DisplayTool, ...DisplayTool[]];

export const displayCaseTools = [
  { label: "Display plinth", icon: "case", assetId: "display-cube-v1" },
  {
    label: "Half glass display case",
    icon: "caseClosed",
    assetId: "display-half-glass-case-v1",
  },
  {
    label: "Full glass display case",
    icon: "caseTallClosed",
    assetId: "display-full-glass-case-v1",
  },
  {
    label: "One-sided glass display case",
    icon: "caseTall",
    assetId: "display-one-sided-glass-case-v1",
  },
] satisfies [DisplayTool, ...DisplayTool[]];
