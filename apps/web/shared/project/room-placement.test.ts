import { describe, expect, it } from "vitest";
import { placeRoom } from "./room-placement";

const assets = [
  { id: "room", room: { width: 10, depth: 10 } },
  { id: "module", room: { width: 10, depth: 10, environmentAssetId: "room" } },
  { id: "small", room: { width: 6, depth: 4, environmentAssetId: "room" } },
];
const scene = { environmentAssetId: "room" };
const transform = {
  position: [10, 0, 0] as const,
  rotation: [0, 0, 0, 1] as const,
  scale: [1, 1, 1] as const,
};
const placed = { id: "placed", name: "Room", assetId: "module", transform };

describe("floor room placement", () => {
  it.each([
    [9.4, 9, 0.3, 10, 0],
    [-9.4, 2, 0, -10, 0],
    [0.3, 8, 9.5, 0, 10],
    [0, -8, -9.5, 0, -10],
  ])("snaps a nearby side to the room and locks its floor", (x, y, z, expectedX, expectedZ) => {
    expect(placeRoom("module", [x, y, z], assets, [], scene)).toMatchObject({
      position: [expectedX, 0, expectedZ],
      valid: true,
      snapped: "room",
    });
  });
  it("snaps detached rooms to the metre grid", () => {
    expect(placeRoom("module", [24.3, 7, 21.7], assets, [], scene)).toMatchObject({
      position: [24, 0, 22],
      valid: true,
      snapped: "grid",
    });
  });
  it("rejects overlap and never treats a corner-only touch as attached", () => {
    expect(placeRoom("module", [0, 0, 0], assets, [], scene).valid).toBe(false);
    expect(placeRoom("module", [10, 0, 10], assets, [], scene)).toMatchObject({
      valid: true,
      snapped: "grid",
    });
  });
  it("uses both room widths, aligns edges, and detects another occupied room", () => {
    expect(placeRoom("small", [8.4, 0, 3.1], assets, [], scene)).toMatchObject({
      position: [8, 0, 3],
      valid: true,
      snapped: "room",
    });
    expect(placeRoom("module", [10, 0, 0], assets, [placed], scene).valid).toBe(false);
    expect(placeRoom("module", [10, 0, 0], assets, [placed], scene, "placed").valid).toBe(true);
  });
  it("finds free adjacent space for click/keyboard placement", () => {
    const result = placeRoom("module", undefined, assets, [placed], scene);
    expect(result.valid).toBe(true);
    expect(result.snapped).toBe("room");
    expect(result.position).not.toEqual([10, 0, 0]);
    expect(Math.abs(result.position[0]) + Math.abs(result.position[2])).toBe(10);
  });
  it("does not accept non-finite coordinates", () => {
    expect(placeRoom("module", [Infinity, 0, 0], assets, [], scene).valid).toBe(false);
  });
});
