import type { ProjectDocument } from "./project-types";
import { validateProjectStructure } from "./project-structure-validation";
import { invalid } from "./validation-helpers";
import type { ValidationResult } from "./validation-helpers";

// UUID text form with all five groups present
// Uppercase letters are allowed in saved IDs too
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkEntityId(
  id: string,
  path: string,
  seen: Map<string, string>,
): ValidationResult<true> {
  if (id.length !== 36 || !UUID_TEXT.test(id)) {
    return invalid(path, "Expected a UUID in 8-4-4-4-12 hexadecimal form");
  }

  // Compare UUIDs without letter case; keep the saved spelling untouched
  // Remember the first location so a duplicate error points to both entries
  const key = id.toLowerCase();
  const previousPath = seen.get(key);
  if (previousPath !== undefined) {
    return invalid(path, `ID already used at ${previousPath}`);
  }
  seen.set(key, path);
  return { ok: true, value: true };
}

function checkAsset(
  id: string,
  expectedKind: "environment" | "model",
  path: string,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<true> {
  // Asset IDs match the registry exactly, including letter case
  const kind = assetKinds.get(id);
  if (kind === undefined) {
    return invalid(path, "Asset ID is missing from the supplied registry");
  }
  if (kind !== expectedKind) {
    return invalid(path, `Expected an asset of kind ${expectedKind}`);
  }
  return { ok: true, value: true };
}

// Entry point for checking an already-parsed project
// Caller supplies assetId -> kind entries from its trusted asset catalog
// File import still needs byte and nesting limits before JSON parsing
export function validateProject(
  raw: unknown,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<ProjectDocument> {
  const result = validateProjectStructure(raw);
  if (!result.ok) {
    return result;
  }

  // One ID pool across the project, scenes and placed objects
  // Sharing an asset is fine; each placed copy needs its own entity ID
  const seen = new Map<string, string>();
  const projectId = checkEntityId(result.value.projectId, "project.projectId", seen);
  if (!projectId.ok) {
    return projectId;
  }
  for (const [sceneIndex, scene] of result.value.scenes.entries()) {
    const path = `project.scenes[${sceneIndex}]`;
    const sceneId = checkEntityId(scene.id, `${path}.id`, seen);
    if (!sceneId.ok) {
      return sceneId;
    }
    const environment = checkAsset(
      scene.environmentAssetId,
      "environment",
      `${path}.environmentAssetId`,
      assetKinds,
    );
    if (!environment.ok) {
      return environment;
    }
    for (const [objectIndex, object] of scene.objects.entries()) {
      const objectPath = `${path}.objects[${objectIndex}]`;
      const objectId = checkEntityId(object.id, `${objectPath}.id`, seen);
      if (!objectId.ok) {
        return objectId;
      }
      const asset = checkAsset(object.assetId, "model", `${objectPath}.assetId`, assetKinds);
      if (!asset.ok) {
        return asset;
      }
    }
  }

  // Return the separate copy already built by the structure and spatial checks
  return result;
}
