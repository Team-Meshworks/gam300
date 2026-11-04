export const exhibitMaterials = [
  "plain",
  "wood",
  "glass",
  "leather",
  "marble",
  "tile",
  "concrete",
  "ceramic",
] as const;
export type ExhibitMaterial = (typeof exhibitMaterials)[number];
export type ExhibitAppearance = Readonly<{ color: string; material: ExhibitMaterial }>;
export const exhibitColors = [
  "#3d3133",
  "#bd2949",
  "#2ca343",
  "#853dc0",
  "#cdbc43",
  "#2aaebe",
  "#46577d",
  "#b67a38",
] as const;
export const defaultAppearance: ExhibitAppearance = { color: "#e8e7df", material: "plain" };

export function textColorOn(background: string): string {
  const channels = [1, 3, 5]
    .map((index) => parseInt(background.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]! < 0.179
    ? "#ffffff"
    : "#292522";
}
