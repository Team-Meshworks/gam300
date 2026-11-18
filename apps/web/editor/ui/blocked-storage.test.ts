import { afterAll, beforeAll, expect, it } from "vitest";
import type {} from "vitest/jsdom";
import { loadFavourites, saveFavourites } from "./asset-filters";
import { loadDockEdge, saveDockEdge } from "./dock-edge";

const initialUrl = window.location.href;
beforeAll(() => jsdom.reconfigure({ url: "about:blank" }));
afterAll(() => jsdom.reconfigure({ url: initialUrl }));

it("keeps favourites usable when this origin cannot access storage", () => {
  expect(() => localStorage).toThrow(/opaque origin/i);
  expect(() => saveFavourites(["vase"])).not.toThrow();
  expect(loadFavourites()).toEqual([]);
});

it("uses the bottom dock when this origin cannot access storage", () => {
  expect(() => localStorage).toThrow(/opaque origin/i);
  expect(() => saveDockEdge("left")).not.toThrow();
  expect(loadDockEdge()).toBe("bottom");
});
