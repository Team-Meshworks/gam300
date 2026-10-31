import { createRequire } from "node:module";
const requireFromWeb = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { validateBytes } = requireFromWeb("gltf-validator");

// Reuse the delivery pipeline's structural rules for every candidate before review
// No external resource resolver is supplied, so validation never fetches remote URLs
export async function validateGlb(bytes, policy = {}) {
  // Run the standard format validator first, then apply the application's narrower delivery policy
  // Return warning diagnostics for review while rejecting actual structural errors
  const report = await validateBytes(new Uint8Array(bytes), {
    uri: "candidate.glb",
    maxIssues: 100,
  });
  if (report.issues.numErrors > 0)
    throw new Error(
      "GLB validation failed: " +
        report.issues.messages
          .filter((issue) => issue.severity === 0)
          .map((issue) => issue.code)
          .slice(0, 8)
          .join(", "),
    );
  validateGlbPolicy(bytes, policy);
  return report;
}

// Keep the resource and loader policy identical for repository files and uploaded candidates
export function validateGlbPolicy(bytes, policy = {}) {
  // Check container bounds before reading offsets or decoding the embedded document
  if (
    bytes.length < 20 ||
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new Error("invalid GLB 2 header or length");

  // Require an aligned JSON chunk fully contained in the uploaded buffer
  const jsonLength = bytes.readUInt32LE(12);
  if (
    bytes.readUInt32LE(16) !== 0x4e4f534a ||
    jsonLength % 4 ||
    20 + jsonLength > bytes.length
  )
    throw new Error("invalid GLB JSON chunk");
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  if (gltf.asset?.version !== "2.0") throw new Error("expected glTF 2.0");

  // Keep unsupported loader features out of both catalogue builds and administrative uploads
  if ((gltf.extensionsRequired ?? []).length)
    throw new Error("required extensions need explicit loader review");
  if (
    policy.animationPolicy !== undefined &&
    policy.animationPolicy !== "static-only"
  )
    throw new Error("unsupported animation policy");
  if ((gltf.skins ?? []).length)
    throw new Error("baseline does not support skinned assets");
  if (
    (gltf.animations ?? []).length &&
    policy.animationPolicy !== "static-only"
  )
    throw new Error(
      "animated assets require explicit static-only policy or loader review",
    );
  if (policy.placement !== undefined && policy.placement !== "bottom-center")
    throw new Error("unsupported placement convention");

  // Self-contained GLBs may embed data URIs but must never trigger filesystem or network resolution
  for (const resource of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
    if (resource.uri && !resource.uri.startsWith("data:"))
      throw new Error("external resource found; export a self-contained GLB");
  }
}
