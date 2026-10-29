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
