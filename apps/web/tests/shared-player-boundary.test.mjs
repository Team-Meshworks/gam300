import assert from "node:assert/strict";
import test from "node:test";
import { scan } from "../architecture.mjs";

test("student preview and published links reach the same player without visitor imports of authoring code", () => {
  const { graph } = scan();
  const reach = (entry) => {
    const files = new Set([entry]);
    for (const file of files) {
      for (const edge of graph.imports) {
        if (edge.file === file && typeof edge.target === "string") files.add(edge.target);
      }
    }
    return files;
  };
  const published = reach("visitor/main.tsx");
  const preview = reach("editor/App.tsx");
  assert.ok(![...published].some((file) => file.startsWith("editor/")));
  for (const part of [
    "ExhibitionPlayer.tsx",
    "ExhibitionCanvas.tsx",
    "ExhibitionContent.tsx",
    "playback.ts",
  ]) {
    const path = "shared/player/" + part;
    assert.ok(published.has(path) && preview.has(path), "Both entry points must reach " + path);
  }
});
