import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { assetCataloguePlugin } from "../asset-catalogue-plugin.ts";

for (const mode of ["development", "production"]) {
  const result = await build({
    configFile: false,
    root: fileURLToPath(new URL("../editor/", import.meta.url)),
    mode,
    logLevel: "silent",
    plugins: [
      assetCataloguePlugin(),
      {
        name: "catalogue-check-entry",
        resolveId(id) {
          if (id === "catalogue-check") return "\0catalogue-check";
        },
        load(id) {
          if (id === "\0catalogue-check")
            return 'export { assets } from "virtual:asset-catalogue";';
        },
      },
    ],
    build: {
      write: false,
      copyPublicDir: false,
      // Even tiny thumbnails must never become public inline data URLs.
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rolldownOptions: { input: "catalogue-check", preserveEntrySignatures: "strict" },
    },
  });
  assert.ok("output" in result);
  const hashes = new Set();
  for (const output of result.output) {
    if (output.type !== "asset") continue;
    const hash = createHash("sha256").update(output.source).digest("hex");
    assert.match(output.fileName, new RegExp(`^restricted-assets/${hash}\\.[a-z0-9]+$`));
    hashes.add(hash);
  }
  const manifest = JSON.parse(
    readFileSync(new URL("../../../assets/manifest.json", import.meta.url), "utf8"),
  );
  for (const entry of manifest.assets) {
    if (entry.assetId.startsWith("room-") || entry.assetId === "library-untitled-v1") {
      assert.ok(hashes.has(entry.sha256), entry.assetId);
    }
  }
  assert.ok(hashes.size > 0);
  console.log(
    `PASS: ${mode} build emits ${hashes.size} catalogue files only in restricted-assets.`,
  );
}
