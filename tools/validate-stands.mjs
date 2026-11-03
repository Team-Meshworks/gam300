import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const assetsRoot = new URL("../assets/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", assetsRoot), "utf8"));
const expected = new Map([
  ["display-cube-v1", "physical"],
  ["display-full-glass-case-v1", "physical"],
  ["display-half-glass-case-v1", "physical"],
  ["display-one-sided-glass-case-v1", "physical"],
  ["display-rectangle-stand-v1", "digital"],
  ["display-rectangle-panel-v1", "digital"],
  ["display-square-stand-v1", "digital"],
]);
for (const [id, role] of expected) {
  const asset = manifest.assets.find((entry) => entry.assetId === id);
  assert.ok(asset, `Missing ${id}`);
  assert.equal(asset.displayRole, role);
  assert.equal(asset.placement, "bottom-center");
  assert.equal(asset.kind, "model");
  assert.equal(asset.thumbnailMode, "generated");
  assert.equal(asset.access, "development-only");
  assert.equal(asset.license.status, "pending-team-confirmation");
  const delivery = readFileSync(new URL(asset.file, assetsRoot));
  const source = readFileSync(new URL(asset.sourceFile, assetsRoot));
  assert.deepEqual(delivery, source, `${id}: preserve original bytes`);
  assert.equal(delivery.length, asset.byteSize);
  assert.equal(createHash("sha256").update(delivery).digest("hex"), asset.sha256);
  if (role === "physical") {
    assert.ok(Number.isFinite(asset.displayTop) && asset.displayTop > 0);
  } else {
    const surface = asset.displaySurface;
    assert.equal(surface.position.length, 3);
    assert.ok(surface.position.every(Number.isFinite));
    assert.equal(surface.rotation.length, 4);
    assert.ok(Math.abs(Math.hypot(...surface.rotation) - 1) < 0.0001);
    assert.ok(surface.width > 0 && surface.height > 0);
  }
}
const plugin = readFileSync(fileURLToPath(new URL("../apps/web/asset-catalogue-plugin.ts", import.meta.url)), "utf8");
for (const id of expected.keys()) assert.ok(plugin.includes(`"${id}"`), `${id}: missing allowlist entry`);
console.log("PASS: seven display assets preserve bytes, hashes, development scope and measured placement metadata");
