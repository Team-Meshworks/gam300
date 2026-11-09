import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const results = join(root, "test-results");
mkdirSync(results, { recursive: true });
const temporary = mkdtempSync(join(results, "asset-validation-"));
const manifest = JSON.parse(
  readFileSync(join(root, "assets/manifest.json"), "utf8"),
);
const fixturePath = join(temporary, "manifest.json");

function validate(...args) {
  const result = spawnSync(
    process.execPath,
    [join(root, "tools/validate-assets.mjs"), ...args],
    {
      cwd: join(root, "apps/web"),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.ifError(result.error);
  return result;
}

try {
  const normal = validate();
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  for (const asset of manifest.assets)
    assert.ok(normal.stdout.includes(`OK: ${asset.assetId} (`));
  process.stdout.write(normal.stdout);
  process.stderr.write(normal.stderr);

  // Exercise the actual upload worker with enough warnings to hide a later invalid reference
  // A capped report with zero observed errors is incomplete rather than safe to approve
  const warningDocument = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      nodes: Array.from({ length: 110 }, () => ({ unexpectedProperty: true })),
      scenes: [{ nodes: [999] }],
      scene: 0,
    }),
  );
  const jsonLength = Math.ceil(warningDocument.length / 4) * 4;
  const saturated = Buffer.alloc(20 + jsonLength, 0x20);
  saturated.writeUInt32LE(0x46546c67, 0);
  saturated.writeUInt32LE(2, 4);
  saturated.writeUInt32LE(saturated.length, 8);
  saturated.writeUInt32LE(jsonLength, 12);
  saturated.writeUInt32LE(0x4e4f534a, 16);
  warningDocument.copy(saturated, 20);
  const rejected = spawnSync(
    process.execPath,
    [join(root, "tools/validate-intake.mjs")],
    {
      input: saturated,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).valid, false);

  const deliveryFixture = structuredClone(manifest);
  deliveryFixture.assets[0].sourceFile =
    "source/missing-source-for-validation-check.blend";
  writeFileSync(fixturePath, JSON.stringify(deliveryFixture));
  const missingSource = validate(fixturePath);
  assert.equal(
    missingSource.status,
    1,
    missingSource.stdout + missingSource.stderr,
  );
  assert.match(
    missingSource.stderr,
    /missing-source-for-validation-check\.blend/,
  );
  const delivery = validate("--delivery-only", fixturePath);
  assert.equal(delivery.status, 0, delivery.stdout + delivery.stderr);
  for (const asset of manifest.assets)
    assert.ok(delivery.stdout.includes(`OK: ${asset.assetId} (`));

  for (const kind of ["image", "video"]) {
    const invalidMedia = structuredClone(manifest);
    const model = invalidMedia.assets.find(asset => asset.kind === "model");
    const media = invalidMedia.assets.find(asset => asset.kind === kind);
    Object.assign(media, {file:model.file, byteSize:model.byteSize, sha256:model.sha256});
    writeFileSync(fixturePath, JSON.stringify(invalidMedia));
    const invalid = validate("--delivery-only", fixturePath);
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(invalid.stderr, /Invalid media header or mediaType/);
  }

  const escapedFixture = structuredClone(manifest);
  escapedFixture.assets[0].file = "../README.md";
  writeFileSync(fixturePath, JSON.stringify(escapedFixture));
  const escaped = validate("--delivery-only", fixturePath);
  assert.equal(escaped.status, 1, escaped.stdout + escaped.stderr);
  assert.match(escaped.stderr, /path escapes assets folder/);
  console.log(
    "PASS: asset validation resolves repository paths, checks sources and rejects escaping paths",
  );
} finally {
  assert.equal(dirname(realpathSync(temporary)), realpathSync(results));
  rmSync(temporary, { recursive: true, force: true });
}
