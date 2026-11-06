import { afterEach, expect, it, vi } from "vitest";
import { defaultSettings, loadSettings, readSettings } from "./user-settings";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps the volume in range and unknown themes light", () => {
  expect(readSettings({ theme: "purple", volume: 7 })).toEqual({ theme: "light", volume: 1 });
  expect(readSettings({ theme: "dark", volume: 0.2 })).toEqual({ theme: "dark", volume: 0.2 });
});

it("falls back to the defaults when the saved settings are junk", () => {
  vi.stubGlobal("localStorage", { getItem: () => "{not json", setItem: () => {} });
  expect(loadSettings()).toEqual(defaultSettings);
});
