import type { ProjectDocument, ProjectObject, ProjectScene } from "./project-types";
import { validateCameraPose, validateTransform } from "./spatial-validation";
import { checkFields, invalid, isRecord } from "./validation-helpers";
import type { ValidationResult } from "./validation-helpers";
import { MAX_PROJECT_BYTES } from "./project-limits";

// Starting limits from the project handoff
const MAX_OBJECTS_PER_SCENE = 200;

type TextBudget = { remaining: number };

function readText(raw: unknown, path: string, budget: TextBudget): ValidationResult<string> {
  if (typeof raw !== "string") {
    return invalid(path, "Expected a string");
  }

  // Catch oversized text before copying the whole document
  // UTF-8 JSON takes at least as many bytes as these string lengths
  budget.remaining -= raw.length;
  if (budget.remaining < 0) {
    return invalid(path, "Project exceeds the 5 MiB document limit");
  }
  // Preserve names exactly as authored, including spacing
  return { ok: true, value: raw };
}

function validateObject(
  raw: unknown,
  path: string,
  budget: TextBudget,
): ValidationResult<ProjectObject> {
  if (!isRecord(raw)) {
    return invalid(path, "Placed object must be an object");
  }
  const fields = checkFields(raw, ["id", "name", "assetId", "transform"], path);
  if (!fields.ok) {
    return fields;
  }

  // Read the text here; validateProject handles UUIDs and asset references
  const id = readText(raw.id, `${path}.id`, budget);
  if (!id.ok) {
    return id;
  }
  const name = readText(raw.name, `${path}.name`, budget);
  if (!name.ok) {
    return name;
  }
  const assetId = readText(raw.assetId, `${path}.assetId`, budget);
  if (!assetId.ok) {
    return assetId;
  }
  const transform = validateTransform(raw.transform, `${path}.transform`);
  if (!transform.ok) {
    return transform;
  }
  return {
    ok: true,
    value: { id: id.value, name: name.value, assetId: assetId.value, transform: transform.value },
  };
}

function validateScene(
  raw: unknown,
  path: string,
  budget: TextBudget,
): ValidationResult<ProjectScene> {
  if (!isRecord(raw)) {
    return invalid(path, "Scene must be an object");
  }
  const fields = checkFields(
    raw,
    ["id", "name", "environmentAssetId", "startCamera", "objects"],
    path,
  );
  if (!fields.ok) {
    return fields;
  }
  // Check the count before walking the object list
  // An empty room is valid while the author is getting started
  if (!Array.isArray(raw.objects) || raw.objects.length > MAX_OBJECTS_PER_SCENE) {
    return invalid(`${path}.objects`, "Objects must be an array with at most 200 entries");
  }
  const id = readText(raw.id, `${path}.id`, budget);
  if (!id.ok) {
    return id;
  }
  const name = readText(raw.name, `${path}.name`, budget);
  if (!name.ok) {
    return name;
  }
  const environmentAssetId = readText(raw.environmentAssetId, `${path}.environmentAssetId`, budget);
  if (!environmentAssetId.ok) {
    return environmentAssetId;
  }
  const camera = validateCameraPose(raw.startCamera, `${path}.startCamera`);
  if (!camera.ok) {
    return camera;
  }

  // Build a separate list in the saved order
  // A later failure leaves the caller's scene untouched
  const objects: ProjectObject[] = [];
  for (const [index, entry] of raw.objects.entries()) {
    const object = validateObject(entry, `${path}.objects[${index}]`, budget);
    if (!object.ok) {
      return object;
    }
    objects.push(object.value);
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      environmentAssetId: environmentAssetId.value,
      startCamera: camera.value,
      objects,
    },
  };
}

// Structure check for already-parsed data
// Use validateProject to include ID and asset-reference checks
// The future file reader must also limit file bytes before parsing
export function validateProjectStructure(raw: unknown): ValidationResult<ProjectDocument> {
  if (!isRecord(raw)) {
    return invalid("project", "Project must be an object");
  }
  // Read the version before interpreting fields from a different format
  if (!Object.hasOwn(raw, "schemaVersion")) {
    return invalid("project.schemaVersion", "Required field is missing");
  }
  if (raw.schemaVersion !== 1) {
    return invalid(
      "project.schemaVersion",
      "Unsupported project format; M1 supports schemaVersion 1",
    );
  }
  const fields = checkFields(raw, ["schemaVersion", "projectId", "title", "scenes"], "project");
  if (!fields.ok) {
    return fields;
  }
  if (!Array.isArray(raw.scenes) || raw.scenes.length !== 1) {
    return invalid("project.scenes", "M1 projects must contain exactly one scene");
  }

  // Share the text budget across the whole project
  const budget = { remaining: MAX_PROJECT_BYTES };
  const projectId = readText(raw.projectId, "project.projectId", budget);
  if (!projectId.ok) {
    return projectId;
  }
  const title = readText(raw.title, "project.title", budget);
  if (!title.ok) {
    return title;
  }
  const scene = validateScene(raw.scenes[0], "project.scenes[0]", budget);
  if (!scene.ok) {
    return scene;
  }

  const document: ProjectDocument = {
    schemaVersion: 1,
    projectId: projectId.value,
    title: title.value,
    scenes: [scene.value],
  };
  // Count UTF-8 bytes with JSON punctuation and escaping included
  // Only serialize the checked copy so extra input fields can't enter the output
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_PROJECT_BYTES) {
    return invalid("project", "Project exceeds the 5 MiB document limit");
  }
  return { ok: true, value: document };
}
