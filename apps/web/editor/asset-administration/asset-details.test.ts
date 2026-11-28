import { expect, it } from "vitest";
import type { AssetCandidate } from "./asset-administration";
import { detailsUpdate } from "./asset-details";

const opened = {
  id: "asset-1",
  name: "Calm piano",
  kind: "audio",
  category: "BGM",
  status: "approved",
  hidden: false,
  deleted: false,
  thumbnail: null,
  validation: [],
  actions: ["hide", "delete"],
  source: "Library",
  license: "CC0",
  reviewNotes: "Reviewed",
  tags: ["Post-war", "Early Singapore"],
} as unknown as AssetCandidate;

const form = {
  name: "Calm piano",
  kind: "audio" as const,
  category: "BGM",
  review: { source: "Library", license: "CC0", reviewNotes: "Reviewed" },
  tags: ["Post-war", "Early Singapore"],
};

it("leaves unchanged tags out of a rename so other admins' tag edits survive", () => {
  const update = detailsUpdate(opened, { ...form, name: "Renamed piano" });
  expect(update.name).toBe("Renamed piano");
  expect("tags" in update).toBe(false);
  expect(update.expected?.name).toBe("Calm piano");
});

it("sends changed tags with what the form opened with, so the server can reject a stale edit", () => {
  const update = detailsUpdate(opened, { ...form, tags: ["Early Singapore"] });
  expect(update.tags).toEqual(["Early Singapore"]);
  expect(update.expected).toEqual({
    name: "Calm piano",
    category: "BGM",
    review: { source: "Library", license: "CC0", reviewNotes: "Reviewed" },
    tags: ["Post-war", "Early Singapore"],
  });
});
