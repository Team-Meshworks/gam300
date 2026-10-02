import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const assetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Resolve the validator from the existing web package
const requireFromWeb = createRequire(
  resolve(assetsRoot, "../web/package.json"),
);
const { validateBytes } = requireFromWeb("gltf-validator");
const deliveryOnly = process.argv.includes("--delivery-only");
const manifestArgument = process.argv.slice(2).find((argument) => argument !== "--delivery-only");
const manifestPath = manifestArgument ? resolve(manifestArgument) : resolve(assetsRoot, "manifest.json");
let errors = 0;
let warnings = 0;
function error(message) { console.error(`ERROR: ${message}`); errors++; }
function warn(message) { console.warn(`WARNING: ${message}`); warnings++; }
async function assetFile(path) {
  if (typeof path !== "string" || !path || isAbsolute(path)) throw new Error("expected a relative asset path");
  const root = await realpath(assetsRoot);
  const target = await realpath(resolve(root, path));
  const local = relative(root, target);
  if (local === ".." || local.startsWith("../") || local.startsWith("..\\") || isAbsolute(local)) throw new Error("path escapes assets folder");
  return readFile(target);
}
try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error("expected schemaVersion 1 and a nonempty assets array");
  const ids = new Set();
  for (const asset of manifest.assets) {
    const label = asset?.assetId ?? "unnamed entry";
    try {
      if (!asset || typeof asset.assetId !== "string" || !asset.assetId.trim()) throw new Error("missing assetId");
      if (ids.has(asset.assetId)) throw new Error("duplicate assetId");
      ids.add(asset.assetId);
      if (!["environment", "model"].includes(asset.kind)) throw new Error("unsupported kind");
      if (asset.mediaType !== "model/gltf-binary") throw new Error("expected model/gltf-binary");
      for (const key of ["name", "category"]) if (typeof asset[key] !== "string" || !asset[key].trim()) throw new Error(`missing ${key}`);
      if (asset.access !== "development-only") throw new Error("baseline assets must remain development-only");
      if (!asset.license || typeof asset.license.provenance !== "string" || !asset.license.provenance.trim()) throw new Error("missing provenance");
      if (asset.license.status !== "approved") warn(`${label}: distribution licence not confirmed`);
      const bytes = await assetFile(asset.file);
      if (bytes.toString("utf8", 0, 43).startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error("Git LFS pointer found; run git lfs pull before building");
      const report = await validateBytes(new Uint8Array(bytes), {
  uri: asset.file,
  maxIssues: 100,
});

for (const issue of report.issues.messages) {
  const message = `${label}: ${issue.code}: ${issue.message}`;

  if (issue.severity === 0) {
    error(message);
  } else if (issue.severity === 1) {
    warn(message);
  }
}

if (report.issues.numErrors > 0) {
  continue;
}
      if (!asset.file.endsWith(".glb")) throw new Error("expected a .glb file");
      if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize !== bytes.length) throw new Error("byteSize differs from file");
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (asset.sha256 !== hash) throw new Error("SHA-256 differs; review changed bytes and assign a new asset ID for a new delivery version");
      if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error("invalid GLB 2 header or length");
      const jsonLength = bytes.readUInt32LE(12);
      if (bytes.readUInt32LE(16) !== 0x4e4f534a || jsonLength % 4 || 20 + jsonLength > bytes.length) throw new Error("invalid GLB JSON chunk");
      const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
      if (gltf.asset?.version !== "2.0") throw new Error("expected glTF 2.0");
      if ((gltf.extensionsRequired ?? []).length) throw new Error("required extensions need explicit loader review");
      if (asset.animationPolicy !== undefined && asset.animationPolicy !== "static-only") throw new Error("unsupported animation policy");
      if ((gltf.skins ?? []).length) throw new Error("baseline does not support skinned assets");
      if ((gltf.animations ?? []).length && asset.animationPolicy !== "static-only") throw new Error("animated assets require explicit static-only policy or loader review");
      if (asset.placement !== undefined && asset.placement !== "bottom-center") throw new Error("unsupported placement convention");
      for (const resource of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
        if (resource.uri && !resource.uri.startsWith("data:")) throw new Error("external resource found; export a self-contained GLB");
      }
      if (asset.thumbnail === null) {
        if (asset.thumbnailMode !== "generated") warn(`${label}: thumbnail still needed`);
      }
      else await assetFile(asset.thumbnail);
      if (!deliveryOnly) await assetFile(asset.sourceFile);
      console.log(`OK: ${label} (${bytes.length} bytes)`);
    } catch (failure) { error(`${label}: ${failure.message}`); }
  }
} catch (failure) { error(failure.message); }
console.log(
  `Asset validation: ${errors} error(s), ${warnings} warning(s). Browser visual verification is still required.`,
);
process.exitCode = errors ? 1 : 0;
