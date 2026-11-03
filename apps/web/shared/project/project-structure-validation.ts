import { encodeProjectJson } from "./project-wire";
import type {
  Interaction,
  ProjectDocument,
  ProjectHotspot,
  ProjectObject,
  ProjectScene,
} from "./project-types";
import { validateCameraPose, validatePosition, validateTransform } from "./spatial-validation";
import { checkFields, invalid, isRecord } from "./validation-helpers";
import type { ValidationResult } from "./validation-helpers";
import { MAX_PROJECT_BYTES } from "./project-limits";
import { validateContentStructure } from "./project-content-validation";
import {
  isPortableHttpsUrl,
  MAX_PORTABLE_URL_LENGTH,
  PORTABLE_HTTPS_URL_ERROR,
} from "./portable-url";

// Starting limits from the project handoff
const MAX_OBJECTS_PER_SCENE = 200;
const MAX_HOTSPOTS_PER_SCENE = 200;
const MAX_INTERACTIONS_PER_SCENE = 200;
const MAX_ELAPSED_SECONDS = 86_400;

type TextBudget = { remaining: number };

export type ProjectStructureOptions = {
  readonly allowDraftLinks?: boolean;
};

function readText(raw: unknown, path: string, budget: TextBudget): ValidationResult<string> {
  if (typeof raw !== "string") {
    return invalid(path, "Expected a string");
  }
  // PostgreSQL jsonb cannot store NUL; reject it without altering authored text
  if (raw.includes("\u0000")) {
    return invalid(path, "Text contains an unsupported NUL character");
  }
  if (/[\ud800-\udfff]/u.test(raw)) {
    return invalid(path, "Text contains invalid Unicode");
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

function validateHotspot(
  raw: unknown,
  path: string,
  budget: TextBudget,
): ValidationResult<ProjectHotspot> {
  if (!isRecord(raw)) {
    return invalid(path, "Hotspot must be an object");
  }
  const fields = checkFields(raw, ["id", "objectId", "position"], path);
  if (!fields.ok) {
    return fields;
  }

  const id = readText(raw.id, `${path}.id`, budget);
  if (!id.ok) {
    return id;
  }
  const objectId = readText(raw.objectId, `${path}.objectId`, budget);
  if (!objectId.ok) {
    return objectId;
  }
  const position = validatePosition(raw.position, `${path}.position`);
  if (!position.ok) {
    return position;
  }
  return {
    ok: true,
    value: { id: id.value, objectId: objectId.value, position: position.value },
  };
}

function validateTrigger(
  raw: unknown,
  path: string,
  budget: TextBudget,
): ValidationResult<Interaction["when"]> {
  if (!isRecord(raw)) {
    return invalid(path, "Trigger must be an object");
  }
  if (!Object.hasOwn(raw, "type")) {
    return invalid(`${path}.type`, "Required field is missing");
  }
  switch (raw.type) {
    case "visitor-clicks-hotspot": {
      const fields = checkFields(raw, ["type", "targetHotspotId"], path);
      if (!fields.ok) return fields;
      const target = readText(raw.targetHotspotId, `${path}.targetHotspotId`, budget);
      if (!target.ok) return target;
      return {
        ok: true,
        value: { type: "visitor-clicks-hotspot", targetHotspotId: target.value },
      };
    }
    case "scene-starts": {
      const fields = checkFields(raw, ["type"], path);
      if (!fields.ok) return fields;
      return { ok: true, value: { type: "scene-starts" } };
    }
    case "time-elapsed": {
      const fields = checkFields(raw, ["type", "seconds"], path);
      if (!fields.ok) return fields;
      if (
        typeof raw.seconds !== "number" ||
        !Number.isFinite(raw.seconds) ||
        raw.seconds <= 0 ||
        raw.seconds > MAX_ELAPSED_SECONDS
      ) {
        return invalid(`${path}.seconds`, "Expected a positive number of seconds");
      }
      return { ok: true, value: { type: "time-elapsed", seconds: raw.seconds } };
    }
    default:
      return invalid(`${path}.type`, "Unsupported trigger type");
  }
}

function validateAction(
  raw: unknown,
  path: string,
  budget: TextBudget,
  allowDraftLinks: boolean,
): ValidationResult<Interaction["do"]> {
  if (!isRecord(raw)) {
    return invalid(path, "Action must be an object");
  }
  if (!Object.hasOwn(raw, "type")) {
    return invalid(`${path}.type`, "Required field is missing");
  }
  switch (raw.type) {
    case "open-link": {
      const fields = checkFields(raw, ["type", "url"], path);
      if (!fields.ok) return fields;
      const url = readText(raw.url, `${path}.url`, budget);
      if (!url.ok) return url;
      if (!allowDraftLinks) {
        if (url.value.length > MAX_PORTABLE_URL_LENGTH) {
          return invalid(`${path}.url`, `Text exceeds ${MAX_PORTABLE_URL_LENGTH} characters`);
        }
        if (!isPortableHttpsUrl(url.value)) {
          return invalid(`${path}.url`, PORTABLE_HTTPS_URL_ERROR);
        }
      }
      return { ok: true, value: { type: "open-link", url: url.value } };
    }
    case "play-audio": {
      const fields = checkFields(raw, ["type", "url"], path);
      if (!fields.ok) return fields;
      const url = readText(raw.url, `${path}.url`, budget);
      if (!url.ok) return url;
      if (!allowDraftLinks && url.value.length > MAX_PORTABLE_URL_LENGTH) {
        return invalid(`${path}.url`, `Text exceeds ${MAX_PORTABLE_URL_LENGTH} characters`);
      }
      return { ok: true, value: { type: "play-audio", url: url.value } };
    }
    case "print-hi": {
      const fields = checkFields(raw, ["type"], path);
      if (!fields.ok) return fields;
      return { ok: true, value: { type: "print-hi" } };
    }
    default:
      return invalid(`${path}.type`, "Unsupported action type");
  }
}

function validateInteraction(
  raw: unknown,
  path: string,
  budget: TextBudget,
  allowDraftLinks: boolean,
): ValidationResult<Interaction> {
  if (!isRecord(raw)) {
    return invalid(path, "Interaction must be an object");
  }
  const fields = checkFields(raw, ["when", "do"], path);
  if (!fields.ok) {
    return fields;
  }
  const when = validateTrigger(raw.when, `${path}.when`, budget);
  if (!when.ok) return when;
  const action = validateAction(raw.do, `${path}.do`, budget, allowDraftLinks);
  if (!action.ok) return action;
  return { ok: true, value: { when: when.value, do: action.value } };
}

function validateScene(
  raw: unknown,
  path: string,
  budget: TextBudget,
  allowDraftLinks: boolean,
): ValidationResult<ProjectScene> {
  if (!isRecord(raw)) {
    return invalid(path, "Scene must be an object");
  }
  const fields = checkFields(
    raw,
    ["id", "name", "environmentAssetId", "startCamera", "objects"],
    path,
    ["hotspots", "interactions"],
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

  // Older project files have no hotspots and start with an empty list
  const hotspots: ProjectHotspot[] = [];
  if (raw.hotspots !== undefined) {
    if (!Array.isArray(raw.hotspots) || raw.hotspots.length > MAX_HOTSPOTS_PER_SCENE) {
      return invalid(`${path}.hotspots`, "Hotspots must be an array with at most 200 entries");
    }
    for (const [index, entry] of raw.hotspots.entries()) {
      const hotspot = validateHotspot(entry, `${path}.hotspots[${index}]`, budget);
      if (!hotspot.ok) {
        return hotspot;
      }
      hotspots.push(hotspot.value);
    }
  }

  // Older project files have no interactions and start with an empty list
  const interactions: Interaction[] = [];
  if (raw.interactions !== undefined) {
    if (!Array.isArray(raw.interactions) || raw.interactions.length > MAX_INTERACTIONS_PER_SCENE) {
      return invalid(
        `${path}.interactions`,
        "Interactions must be an array with at most 200 entries",
      );
    }
    for (const [index, entry] of raw.interactions.entries()) {
      const interaction = validateInteraction(
        entry,
        `${path}.interactions[${index}]`,
        budget,
        allowDraftLinks,
      );
      if (!interaction.ok) {
        return interaction;
      }
      interactions.push(interaction.value);
    }
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      environmentAssetId: environmentAssetId.value,
      startCamera: camera.value,
      objects,
      hotspots,
      interactions,
    },
  };
}

// Structure check for already-parsed data
// Use validateProject to include ID and asset-reference checks
// The future file reader must also limit file bytes before parsing
export function validateProjectStructure(
  raw: unknown,
  options: ProjectStructureOptions = {},
): ValidationResult<ProjectDocument> {
  if (!isRecord(raw)) {
    return invalid("project", "Project must be an object");
  }

  // Read the version before interpreting fields from a different format
  if (!Object.hasOwn(raw, "schemaVersion")) {
    return invalid("project.schemaVersion", "Required field is missing");
  }
  // Dispatch v2 before the legacy exact-field checks so each released shape keeps its own rules
  if (raw.schemaVersion === 2) {
    return validateContentStructure(raw, options.allowDraftLinks === true);
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
  const scene = validateScene(
    raw.scenes[0],
    "project.scenes[0]",
    budget,
    options.allowDraftLinks === true,
  );
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
  if (new TextEncoder().encode(encodeProjectJson(document)).byteLength > MAX_PROJECT_BYTES) {
    return invalid("project", "Project exceeds the 5 MiB document limit");
  }
  return { ok: true, value: document };
}
