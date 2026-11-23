import assert from "node:assert/strict";
import test from "node:test";
import { moduleOf, scan } from "../architecture.mjs";

test("published links use the player without importing authoring code", () => {
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
  const published = [...reach("visitor/main.tsx")];
  assert.ok(
    published.some((file) => moduleOf(file) === "player"),
    "Published links must reach the shared player",
  );
  assert.ok(
    !published.some((file) => file.startsWith("editor/")),
    "Published links must stay independent of authoring",
  );
});
