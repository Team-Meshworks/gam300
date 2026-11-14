import { expect, it } from "vitest";
import { needsBaseModel } from "./base-model";
import { uniqueRoomAssets } from "../../shared/asset-runtime/catalogue";

it("asks only on a creator's first saved revision", () => {
  expect(needsBaseModel(0, "Creator", false)).toBe(true);
  expect(needsBaseModel(1, "Creator", false)).toBe(false);
  expect(needsBaseModel(0, "Educator", false)).toBe(false);
  expect(needsBaseModel(0, "Administrator", false)).toBe(false);
});
it("opens recovered work without requiring a new base choice", () => {
  expect(needsBaseModel(0, "Creator", true)).toBe(false);
});

it("shows identical room bytes once and keeps the approved server identity", () => {
  const sample = {
    id: "test-room-v1",
    name: "Starter room",
    kind: "environment" as const,
    url: "/sample",
    sha256: "a".repeat(64),
    thumbnail: null,
  };
  const approved = {
    ...sample,
    id: "758d32a9-fb5c-414f-b3f7-34b95c7bf2bd",
    url: "/api/v1/assets/room/bytes",
  };
  expect(uniqueRoomAssets([sample, { ...sample, id: "crate", kind: "model" }, approved])).toEqual([
    approved,
  ]);
});
