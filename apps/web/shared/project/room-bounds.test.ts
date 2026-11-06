import { describe, expect, it } from "vitest";
import { snapRoomBounds } from "./room-bounds";

describe("room footprint snapping", () => {
  const room = { position: [0, 0, 0] as const, halfWidth: 5, halfDepth: 5 };

  it("places differently sized rooms next to the reference without overlap", () => {
    expect(snapRoomBounds([9.2, 0, 0.2], { halfWidth: 4, halfDepth: 3 }, [room])).toEqual([
      9, 0, 0,
    ]);
  });

  it("rejects positions when every adjacent footprint would fall off the grid", () => {
    expect(snapRoomBounds([0, 0, 0], { halfWidth: 16, halfDepth: 16 }, [room], 20)).toBeNull();
  });

  it("allows larger neighbouring rooms within the expanded room grid", () => {
    expect(
      snapRoomBounds([0, 0, 17], { halfWidth: 9.4, halfDepth: 9.8 }, [
        { position: [0, 0, 0], halfWidth: 12, halfDepth: 7.2 },
      ]),
    ).toEqual([0, 0, 17]);
  });
});
