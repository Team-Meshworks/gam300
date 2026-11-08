import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  STARTER_ROOM_SHA256,
  isStarterRoomEnvironment,
  isStarterRoomModel,
  starterRoomCompanion,
  searchAssets,
  type CatalogueAsset,
} from "./catalogue";
import { createLoadedStore } from "../../tests/project-store-fixture";

const assets: readonly CatalogueAsset[] = Object.freeze([
  Object.freeze({
    id: "chair",
    name: "Blue Chair",
    kind: "model",
    url: "/chair.glb",
    sha256: "",
    thumbnail: null,
  }),
  Object.freeze({
    id: "panel",
    name: "Blue Panel",
    kind: "model",
    url: "/panel.glb",
    sha256: "",
    thumbnail: null,
  }),
  Object.freeze({
    id: "room",
    name: "Gallery",
    kind: "environment",
    url: "/room.glb",
    sha256: "",
    thumbnail: null,
  }),
]);

describe("catalogue search", () => {
  it("matches case-insensitive trimmed asset names", () => {
    expect(searchAssets(assets, "  bLuE  ")).toEqual([assets[0], assets[1]]);
    expect(searchAssets(assets, "panel")).toEqual([assets[1]]);
    expect(searchAssets(assets, "gallery")).toEqual([assets[2]]);
  });

  it("clears to the original order and references without changing the catalogue", () => {
    expect(searchAssets(assets, "chair")[0]).toBe(assets[0]);
    expect(searchAssets(assets, "  ")).toEqual(assets);
    expect(assets.map((asset) => asset.id)).toEqual(["chair", "panel", "room"]);
  });

  it("treats patterns, markup as literal input", () => {
    for (const query of [".*", "[", "<script>", "' OR 1=1 --"]) {
      expect(searchAssets(assets, query)).toEqual([]);
    }
  });

  it("places a search result through existing history and preserves its ID on redo", () => {
    const store = createLoadedStore(assets, "room");
    const match = searchAssets(assets, "BLUE")[0];
    expect(match).toBeDefined();
    const result = store.addObject(match!.id, [1, 0, -2]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const placed = store.getSnapshot();
    expect(placed.objects).toHaveLength(1);
    expect(result.object.assetId).toBe("chair");
    expect(result.object.transform.position).toEqual([1, 0, -2]);

    searchAssets(assets, "nothing");
    searchAssets(assets, "");
    expect(store.getSnapshot()).toBe(placed);
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(0);
    store.redo();
    expect(store.getSnapshot().objects[0]?.id).toBe(result.object.id);
  });
});

it("recognizes only matching non-empty Starter room hashes", () => {
  const starterHash = "121c9d86eefb1961a697a390967dfeface3ce1f612334d2fbc447551ddfd88d1";
  const environment: CatalogueAsset = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Room",
    kind: "environment",
    url: "/room.glb",
    sha256: "",
    thumbnail: null,
  };
  const module: CatalogueAsset = { ...environment, id: "test-room-module-v1", kind: "model" };
  expect(isStarterRoomEnvironment([environment, module], environment.id)).toBe(false);
  expect(
    isStarterRoomEnvironment(
      [
        { ...environment, sha256: "a".repeat(64) },
        { ...module, sha256: "b".repeat(64) },
      ],
      environment.id,
    ),
  ).toBe(false);
  expect(
    isStarterRoomEnvironment(
      [
        { ...environment, sha256: "A".repeat(64) },
        { ...module, sha256: "a".repeat(64) },
      ],
      environment.id,
    ),
  ).toBe(false);
  expect(
    isStarterRoomEnvironment(
      [
        { ...environment, sha256: starterHash.toUpperCase() },
        { ...module, id: "33333333-3333-4333-8333-333333333333", sha256: starterHash },
      ],
      environment.id,
    ),
  ).toBe(true);
  const approvedModel = {
    ...module,
    id: "33333333-3333-4333-8333-333333333333",
    sha256: starterHash,
  };
  expect(isStarterRoomModel([approvedModel], approvedModel.id)).toBe(true);
  expect(starterRoomCompanion([approvedModel])?.id).toBe(approvedModel.id);
  expect(starterRoomCompanion([{ ...approvedModel, sha256: "b".repeat(64) }])).toBeUndefined();
});

it("pins Starter geometry to both packaged manifest entries", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../../assets/manifest.json", import.meta.url), "utf8"),
  ) as { assets: { assetId: string; sha256: string }[] };
  for (const id of ["test-room-v1", "test-room-module-v1"])
    expect(manifest.assets.find((asset) => asset.assetId === id)?.sha256).toBe(STARTER_ROOM_SHA256);
});

it("keeps approved room geometry aligned with the matching asset hashes", async () => {
  const { knownRoomGeometry } = await import("./catalogue");
  const manifest = JSON.parse(
    readFileSync(new URL("../../../../assets/manifest.json", import.meta.url), "utf8"),
  );
  const rooms = manifest.assets.filter(
    (asset: { kind: string; assetId: string }) =>
      asset.kind === "environment" && /^room-(?:space1|doors-[1-4-]+)-v1$/.test(asset.assetId),
  );
  expect(rooms.length).toBe(16);
  for (const room of rooms) {
    expect(knownRoomGeometry[room.sha256]).toEqual(room.boundsMeters);
    const modelId = room.assetId.replace(/-v1$/, "-module-v1");
    const model = manifest.assets.find((asset: { assetId: string }) => asset.assetId === modelId);
    expect(model?.kind).toBe("model");
    expect(model?.sha256).toBe(room.sha256);
    expect(model?.boundsMeters).toEqual(room.boundsMeters);
  }
});
