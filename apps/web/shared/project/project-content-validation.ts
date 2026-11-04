import { exhibitMaterials, type ExhibitAppearance } from "./project-appearance";
import { encodeProjectJson } from "./project-wire";
import type {
  ContentComponent,
  ContentProject,
  ProjectAction,
  ProjectTrigger,
  TextMark,
} from "./project-content";
import { MAX_PROJECT_BYTES } from "./project-limits";
import {
  isPortableHttpsUrl,
  MAX_PORTABLE_URL_LENGTH,
  PORTABLE_HTTPS_URL_ERROR,
} from "./portable-url";
import type { Interaction, ProjectHotspot } from "./project-types";
import { validateCameraPose, validatePosition, validateTransform } from "./spatial-validation";
import { checkFields, invalid, isRecord, type ValidationResult } from "./validation-helpers";

// Stop at the first bad field while preserving its path for import feedback
class ContentError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}
function fail(path: string, message: string): never {
  throw new ContentError(path, message);
}

// Adapt shared spatial and field validators into the same first-error flow
function checked<T>(result: ValidationResult<T>): T {
  if (!result.ok) {
    fail(result.error.path, result.error.message);
  }
  return result.value;
}
function record(
  raw: unknown,
  fields: readonly string[],
  path: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(raw)) {
    fail(path, "Expected an object");
  }

  // Reject extra fields too, including server authority accidentally embedded in a file
  checked(checkFields(raw, fields, path, optional));
  return raw;
}

// Match C# UTF-16 text limits and reject lone surrogates before JSON can replace them
function text(raw: unknown, path: string, limit = 256): string {
  if (typeof raw !== "string" || raw.length > limit) {
    fail(path, `Expected text with at most ${limit} characters`);
  }
  // Keep file and server storage acceptance identical
  if (raw.includes("\u0000")) {
    fail(path, "Text contains an unsupported NUL character");
  }
  if (/[\ud800-\udfff]/u.test(raw)) {
    fail(path, "Text contains invalid Unicode");
  }
  return raw;
}
function appearance(raw: unknown, path: string): ExhibitAppearance {
  const value = record(raw, ["color", "material"], path);
  const color = text(value.color, `${path}.color`, 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail(`${path}.color`, "Choose a six-digit colour");
  const material = text(value.material, `${path}.material`);
  if (!(exhibitMaterials as readonly string[]).includes(material))
    fail(`${path}.material`, "Choose a supported material");
  return { color, material: material as ExhibitAppearance["material"] };
}
function flag(raw: unknown, path: string): boolean {
  // Do not coerce strings or numbers from imported files into authored flags
  if (typeof raw !== "boolean") {
    fail(path, "Expected a boolean");
  }
  return raw;
}

// Bounds apply to actual finite numbers, including timing and media values
function number(raw: unknown, path: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    fail(path, `Expected a finite number between ${min} and ${max}`);
  }
  return raw;
}
function list<T>(
  raw: unknown,
  path: string,
  limit: number,
  read: (item: unknown, path: string) => T,
): T[] {
  // Check size first, then rebuild entries in their authored order with indexed error paths
  if (!Array.isArray(raw) || raw.length > limit) {
    fail(path, `Expected an array with at most ${limit} entries`);
  }
  return Array.from(raw, (item, index) => read(item, `${path}[${index}]`));
}

// Null attaches to the scene root; resolve non-null parent IDs after indexing the document
function parent(raw: unknown, path: string): string | null {
  return raw === null ? null : text(raw, path);
}
function transform(raw: unknown, path: string) {
  // Reuse spatial checks and apply v2's bounded scale without changing the released v1 limits
  const value = checked(validateTransform(raw, path));
  value.scale.forEach((axis, index) =>
    number(axis, `${path}.scale[${index}]`, Number.MIN_VALUE, 10000),
  );
  return value;
}

function component(raw: unknown, path: string): ContentComponent {
  // The type tag selects an exact field set before values are copied into the checked component
  if (!isRecord(raw)) {
    fail(path, "Expected a component");
  }
  const type = raw.type;
  const variants: Record<string, readonly string[]> = {
    hotspot: ["label"],
    text: ["runs", "caption"],
    image: ["assetId", "caption", "alt"],
    audio: ["assetId", "caption", "loop", "volume", "mode"],
    video: ["assetId", "caption", "loop", "volume"],
    navigationPoint: ["label", "sceneId", "viewpointId"],
  };
  if (typeof type !== "string" || !Object.hasOwn(variants, type)) {
    fail(`${path}.type`, "Unsupported component type");
  }
  record(
    raw,
    ["id", "type", ...variants[type]!],
    path,
    type === "text" ? ["placement", "background", "color", "fontSize"] : [],
  );
  const id = text(raw.id, `${path}.id`);
  switch (type) {
    case "hotspot":
      return { id, type, label: text(raw.label, `${path}.label`) };
    case "text": {
      if (
        raw.background !== undefined &&
        raw.background !== "transparent" &&
        (typeof raw.background !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw.background))
      )
        fail(`${path}.background`, "Choose a background color or transparent");
      if (
        raw.color !== undefined &&
        (typeof raw.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw.color))
      )
        fail(`${path}.color`, "Choose a text color");
      // Bound the whole panel so splitting text into many runs cannot bypass its limit
      let length = 0;
      const runs = list(raw.runs, `${path}.runs`, 256, (input, path) => {
        const run = record(input, ["text", "marks"], path);
        const value = text(run.text, `${path}.text`, 65536);
        length += value.length;
        const marks = list(run.marks, `${path}.marks`, 3, (input, path) => {
          if (input !== "bold" && input !== "italic" && input !== "underline") {
            fail(path, "Unsupported text mark");
          }
          return input as TextMark;
        });
        if (new Set(marks).size !== marks.length) {
          fail(`${path}.marks`, "Text marks must be unique");
        }
        return { text: value, marks };
      });
      if (length > 65536) {
        fail(`${path}.runs`, "Formatted text exceeds 65536 characters");
      }
      return {
        id,
        type,
        runs,
        caption: text(raw.caption, `${path}.caption`, 4096),
        ...(raw.placement === undefined
          ? {}
          : { placement: transform(raw.placement, `${path}.placement`) }),
        ...(raw.background === undefined ? {} : { background: raw.background as string }),
        ...(raw.color === undefined ? {} : { color: raw.color as string }),
        ...(raw.fontSize === undefined
          ? {}
          : { fontSize: number(raw.fontSize, `${path}.fontSize`, 12, 96) }),
      };
    }
    case "image":
      return {
        id,
        type,
        assetId: text(raw.assetId, `${path}.assetId`),
        caption: text(raw.caption, `${path}.caption`, 4096),
        alt: text(raw.alt, `${path}.alt`, 4096),
      };
    // Share media fields while preserving the audio-only spatial or global mode
    case "audio":
    case "video": {
      const media = {
        id,
        assetId: text(raw.assetId, `${path}.assetId`),
        caption: text(raw.caption, `${path}.caption`, 4096),
        loop: flag(raw.loop, `${path}.loop`),
        volume: number(raw.volume, `${path}.volume`, 0, 1),
      };
      if (type === "video") {
        return { ...media, type };
      }
      if (raw.mode !== "spatial" && raw.mode !== "global") {
        fail(`${path}.mode`, "Expected spatial or global audio");
      }
      return { ...media, type, mode: raw.mode };
    }
    // Only navigation remains after the supported tag check; resolve its paired destination later
    default:
      return {
        id,
        type: "navigationPoint",
        label: text(raw.label, `${path}.label`),
        sceneId: text(raw.sceneId, `${path}.sceneId`),
        viewpointId: text(raw.viewpointId, `${path}.viewpointId`),
      };
  }
}

function trigger(raw: unknown, path: string): ProjectTrigger {
  // Validate trigger parameters here; the reference pass checks which entities they target
  if (!isRecord(raw)) {
    fail(path, "Expected a trigger");
  }
  const type = raw.type;
  const variants: Record<string, readonly string[]> = {
    click: ["targetId"],
    zoneEnter: ["zoneId"],
    sceneStart: [],
    elapsed: ["seconds"],
    gaze: ["targetId", "seconds"],
    panelClose: ["panelId"],
  };
  if (typeof type !== "string" || !Object.hasOwn(variants, type)) {
    fail(`${path}.type`, "Unsupported trigger type");
  }
  record(raw, ["type", ...variants[type]!], path);
  switch (type) {
    case "click":
      return { type, targetId: text(raw.targetId, `${path}.targetId`) };
    case "zoneEnter":
      return { type, zoneId: text(raw.zoneId, `${path}.zoneId`) };
    case "sceneStart":
      return { type };
    case "elapsed":
      return { type, seconds: number(raw.seconds, `${path}.seconds`, 0, 86400) };
    case "gaze":
      return {
        type,
        targetId: text(raw.targetId, `${path}.targetId`),
        seconds: number(raw.seconds, `${path}.seconds`, 0.1, 60),
      };
    default:
      return { type: "panelClose", panelId: text(raw.panelId, `${path}.panelId`) };
  }
}

function action(raw: unknown, path: string): ProjectAction {
  // Keep actions as ordered data; importing a rule never performs its effects
  if (!isRecord(raw)) {
    fail(path, "Expected an action");
  }
  const type = raw.type;
  const variants: Record<string, readonly string[]> = {
    showPanel: ["panelId"],
    playMedia: ["mediaId"],
    moveCamera: ["viewpointId", "durationSeconds"],
    setVisible: ["objectId", "visible"],
    navigateScene: ["sceneId", "viewpointId"],
    openLink: ["url"],
  };
  if (typeof type !== "string" || !Object.hasOwn(variants, type)) {
    fail(`${path}.type`, "Unsupported action type");
  }
  record(raw, ["type", ...variants[type]!], path);
  switch (type) {
    case "showPanel":
      return { type, panelId: text(raw.panelId, `${path}.panelId`) };
    case "playMedia":
      return { type, mediaId: text(raw.mediaId, `${path}.mediaId`) };
    case "moveCamera":
      return {
        type,
        viewpointId: text(raw.viewpointId, `${path}.viewpointId`),
        durationSeconds: number(raw.durationSeconds, `${path}.durationSeconds`, 0, 60),
      };
    case "setVisible":
      return {
        type,
        objectId: text(raw.objectId, `${path}.objectId`),
        visible: flag(raw.visible, `${path}.visible`),
      };
    case "navigateScene":
      return {
        type,
        sceneId: text(raw.sceneId, `${path}.sceneId`),
        viewpointId: text(raw.viewpointId, `${path}.viewpointId`),
      };
    default: {
      const url = text(raw.url, `${path}.url`, MAX_PORTABLE_URL_LENGTH);

      // All rejection paths point to the authored URL field; successful reads keep its spelling unchanged
      if (!isPortableHttpsUrl(url)) {
        fail(`${path}.url`, PORTABLE_HTTPS_URL_ERROR);
      }
      return { type: "openLink", url };
    }
  }
}

// Scene-level hotspot markers and interactions predate the content component model
// They remain part of every scene so the editor can keep authored click rules
function hotspot(raw: unknown, path: string): ProjectHotspot {
  const value = record(raw, ["id", "objectId", "position"], path);
  return {
    id: text(value.id, `${path}.id`),
    objectId: text(value.objectId, `${path}.objectId`),
    position: checked(validatePosition(value.position, `${path}.position`)),
  };
}

function interactionTrigger(raw: unknown, path: string): Interaction["when"] {
  if (!isRecord(raw)) {
    fail(path, "Trigger must be an object");
  }
  switch (raw.type) {
    case "visitor-clicks-hotspot":
      record(raw, ["type", "targetHotspotId"], path);
      return {
        type: "visitor-clicks-hotspot",
        targetHotspotId: text(raw.targetHotspotId, `${path}.targetHotspotId`),
      };
    case "scene-starts":
      record(raw, ["type"], path);
      return { type: "scene-starts" };
    case "time-elapsed":
      record(raw, ["type", "seconds"], path);
      return {
        type: "time-elapsed",
        seconds: number(raw.seconds, `${path}.seconds`, Number.MIN_VALUE, 86_400),
      };
    default:
      return fail(`${path}.type`, "Unsupported trigger type");
  }
}

function interactionAction(
  raw: unknown,
  path: string,
  allowDraftLinks: boolean,
): Interaction["do"] {
  if (!isRecord(raw)) {
    fail(path, "Action must be an object");
  }
  switch (raw.type) {
    case "open-link":
    case "play-audio": {
      record(raw, ["type", "url"], path);
      const url = text(
        raw.url,
        `${path}.url`,
        allowDraftLinks ? MAX_PROJECT_BYTES : MAX_PORTABLE_URL_LENGTH,
      );
      if (!allowDraftLinks && raw.type === "open-link" && !isPortableHttpsUrl(url)) {
        fail(`${path}.url`, PORTABLE_HTTPS_URL_ERROR);
      }
      return { type: raw.type, url };
    }
    case "navigate-scene":
      record(raw, ["type", "sceneId"], path);
      return { type: raw.type, sceneId: text(raw.sceneId, `${path}.sceneId`) };
    case "move-to-viewpoint":
      record(raw, ["type", "viewpointId"], path);
      return { type: raw.type, viewpointId: text(raw.viewpointId, `${path}.viewpointId`) };
    case "print-hi":
      record(raw, ["type"], path);
      return { type: "print-hi" };
    default:
      return fail(`${path}.type`, "Unsupported action type");
  }
}

function interaction(raw: unknown, path: string, allowDraftLinks: boolean): Interaction {
  const value = record(raw, ["when", "do"], path);
  return {
    when: interactionTrigger(value.when, `${path}.when`),
    do: interactionAction(value.do, `${path}.do`, allowDraftLinks),
  };
}

export function validateContentStructure(
  raw: unknown,
  allowDraftLinks = false,
): ValidationResult<ContentProject> {
  // Rebuild checked values so imported arrays cannot mutate the live document afterward
  try {
    const root = record(raw, ["schemaVersion", "projectId", "title", "scenes"], "project");
    if (root.schemaVersion !== 2) {
      fail("project.schemaVersion", "Expected schemaVersion 2");
    }
    const projectId = text(root.projectId, "project.projectId");
    const title = text(root.title, "project.title");

    // Read every scene in place so saved ordering also defines navigation and rule ordering
    const scenes = list(root.scenes, "project.scenes", 16, (input, path) => {
      const scene = record(
        input,
        [
          "id",
          "name",
          "environmentAssetId",
          "startCamera",
          "objects",
          "groups",
          "zones",
          "viewpoints",
          "rules",
        ],
        path,
        ["hotspots", "interactions"],
      );
      return {
        id: text(scene.id, `${path}.id`),
        name: text(scene.name, `${path}.name`),
        environmentAssetId: text(scene.environmentAssetId, `${path}.environmentAssetId`),
        startCamera: checked(validateCameraPose(scene.startCamera, `${path}.startCamera`)),
        hotspots:
          scene.hotspots === undefined
            ? []
            : list(scene.hotspots, `${path}.hotspots`, 200, hotspot),
        interactions:
          scene.interactions === undefined
            ? []
            : list(scene.interactions, `${path}.interactions`, 200, (value, path) =>
                interaction(value, path, allowDraftLinks),
              ),
        objects: list(scene.objects, `${path}.objects`, 200, (input, path) => {
          const object = record(
            input,
            ["id", "name", "assetId", "transform", "parentId", "visible", "components"],
            path,
            ["appearance"],
          );
          return {
            id: text(object.id, `${path}.id`),
            name: text(object.name, `${path}.name`),
            assetId: text(object.assetId, `${path}.assetId`),
            transform: transform(object.transform, `${path}.transform`),
            parentId: parent(object.parentId, `${path}.parentId`),
            visible: flag(object.visible, `${path}.visible`),
            components: list(object.components, `${path}.components`, 16, component),
            ...(object.appearance === undefined
              ? {}
              : { appearance: appearance(object.appearance, `${path}.appearance`) }),
          };
        }),
        // Groups express parent membership without introducing another room or transform
        groups: list(scene.groups, `${path}.groups`, 200, (input, path) => {
          const group = record(input, ["id", "name", "parentId"], path);
          return {
            id: text(group.id, `${path}.id`),
            name: text(group.name, `${path}.name`),
            parentId: parent(group.parentId, `${path}.parentId`),
          };
        }),
        // Zones and viewpoints own spatial values independently of the model object list
        zones: list(scene.zones, `${path}.zones`, 64, (input, path) => {
          const zone = record(input, ["id", "name", "transform"], path);
          return {
            id: text(zone.id, `${path}.id`),
            name: text(zone.name, `${path}.name`),
            transform: transform(zone.transform, `${path}.transform`),
          };
        }),
        viewpoints: list(scene.viewpoints, `${path}.viewpoints`, 64, (input, path) => {
          const viewpoint = record(input, ["id", "name", "camera"], path);
          return {
            id: text(viewpoint.id, `${path}.id`),
            name: text(viewpoint.name, `${path}.name`),
            camera: checked(validateCameraPose(viewpoint.camera, `${path}.camera`)),
          };
        }),
        // Preserve trigger and action order even when a rule is currently disabled
        rules: list(scene.rules, `${path}.rules`, 256, (input, path) => {
          const rule = record(input, ["id", "enabled", "trigger", "actions"], path);
          const result = {
            id: text(rule.id, `${path}.id`),
            enabled: flag(rule.enabled, `${path}.enabled`),
            trigger: trigger(rule.trigger, `${path}.trigger`),
            actions: list(rule.actions, `${path}.actions`, 16, action),
          };
          if (result.actions.length === 0) {
            fail(`${path}.actions`, "A rule needs at least one action");
          }
          return result;
        }),
      };
    });
    if (scenes.length === 0) {
      fail("project.scenes", "A project needs at least one scene");
    }

    // Check the complete rebuilt document's byte budget before handing it to reference validation
    const value: ContentProject = { schemaVersion: 2, projectId, title, scenes };
    if (new TextEncoder().encode(encodeProjectJson(value)).byteLength > MAX_PROJECT_BYTES) {
      fail("project", "Project exceeds the 5 MiB document limit");
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ContentError) {
      return invalid(error.path, error.message);
    }
    throw error;
  }
}

export function validateContentReferences(
  project: ContentProject,
  assets: ReadonlyMap<string, string>,
): ValidationResult<ContentProject> {
  try {
    // Index every scene first so forward references and cross-scene navigation are valid
    const entities = new Map<string, { kind: string; scene: string; path: string }>();
    function entity(id: string, kind: string, scene: string, path: string) {
      if (
        id.length !== 36 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ) {
        fail(`${path}.id`, "Expected a UUID");
      }
      // UUID spelling can vary in case while still denoting one globally unique entity
      const key = id.toLowerCase();
      if (entities.has(key)) {
        fail(`${path}.id`, "Entity ID is already used");
      }
      entities.set(key, { kind, scene: scene.toLowerCase(), path });
    }

    // The project identifier shares the entity pool but keeps its public error path
    if (
      project.projectId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project.projectId)
    ) {
      fail("project.projectId", "Expected a UUID");
    }
    entities.set(project.projectId.toLowerCase(), { kind: "project", scene: "", path: "project" });
    project.scenes.forEach((scene, index) => {
      const path = `project.scenes[${index}]`;
      entity(scene.id, "scene", scene.id, path);
      scene.objects.forEach((object, index) => {
        const objectPath = `${path}.objects[${index}]`;
        entity(object.id, "object", scene.id, objectPath);
        object.components.forEach((component, index) =>
          entity(component.id, component.type, scene.id, `${objectPath}.components[${index}]`),
        );
      });
      scene.hotspots.forEach((value, index) =>
        entity(value.id, "hotspot", scene.id, `${path}.hotspots[${index}]`),
      );
      for (const collection of ["groups", "zones", "viewpoints", "rules"] as const) {
        scene[collection].forEach((value, index) =>
          entity(value.id, collection.slice(0, -1), scene.id, `${path}.${collection}[${index}]`),
        );
      }
    });
    function reference(id: string, kinds: readonly string[], scene: string | null, path: string) {
      // Ordinary links stay within their scene; explicit navigation opts into a different scene
      const target = entities.get(id.toLowerCase());
      if (
        !target ||
        !kinds.includes(target.kind) ||
        (scene !== null && target.scene !== scene.toLowerCase())
      ) {
        fail(path, "Reference must point to an allowed entity in the required scene");
      }
    }

    // Catalogue keys stay case-sensitive and must match the kind required by the authored field
    function asset(id: string, kind: string, path: string) {
      if (assets.get(id) !== kind) {
        fail(path, `Expected an approved ${kind} asset`);
      }
    }
    function destination(sceneId: string, viewpointId: string, path: string) {
      // A valid viewpoint in another scene must not be paired with this destination
      reference(sceneId, ["scene"], null, `${path}.sceneId`);
      reference(viewpointId, ["viewpoint"], sceneId, `${path}.viewpointId`);
    }

    // With the full index available, resolve each scene's hierarchy, assets and rule targets
    project.scenes.forEach((scene, index) => {
      const path = `project.scenes[${index}]`;
      asset(scene.environmentAssetId, "environment", `${path}.environmentAssetId`);

      // Check parent targets and build the ancestor map before checking components and rules
      const parents = new Map<string, string | null>();
      for (const [collection, values] of [
        ["objects", scene.objects],
        ["groups", scene.groups],
      ] as const) {
        values.forEach((value, index) => {
          const itemPath = `${path}.${collection}[${index}].parentId`;
          if (value.parentId !== null) {
            reference(value.parentId, ["object", "group"], scene.id, itemPath);
          }
          parents.set(value.id.toLowerCase(), value.parentId?.toLowerCase() ?? null);
        });
      }

      // Follow each ancestor chain before the tree UI or runtime can traverse it
      for (const [id] of parents) {
        const visited = new Set<string>();
        let current: string | null = id;
        while (current !== null) {
          if (visited.has(current)) {
            fail(`${entities.get(id)!.path}.parentId`, "Hierarchy must not contain a cycle");
          }
          visited.add(current);
          current = parents.get(current) ?? null;
        }
      }

      // Model approval does not imply approval of attached media or navigation destinations
      const hotspotObjects = new Set<string>();
      scene.objects.forEach((object, index) => {
        const objectPath = `${path}.objects[${index}]`;
        asset(object.assetId, "model", `${objectPath}.assetId`);
        object.components.forEach((component, index) => {
          const componentPath = `${objectPath}.components[${index}]`;
          if ("assetId" in component) {
            asset(component.assetId, component.type, `${componentPath}.assetId`);
          }
          if (component.type === "navigationPoint") {
            destination(component.sceneId, component.viewpointId, componentPath);
          }
        });
      });

      // Scene-level hotspots attach to objects and drive the authored click interactions
      scene.hotspots.forEach((hotspot, index) => {
        const objectKey = hotspot.objectId.toLowerCase();
        reference(hotspot.objectId, ["object"], scene.id, `${path}.hotspots[${index}].objectId`);
        if (hotspotObjects.has(objectKey)) {
          fail(`${path}.hotspots[${index}].objectId`, "Each object can have at most one hotspot");
        }
        hotspotObjects.add(objectKey);
      });
      scene.interactions.forEach((value, index) => {
        const actionPath = `${path}.interactions[${index}].do`;
        if (value.do.type === "navigate-scene") {
          reference(value.do.sceneId, ["scene"], null, `${actionPath}.sceneId`);
        } else if (value.do.type === "move-to-viewpoint") {
          reference(value.do.viewpointId, ["viewpoint"], scene.id, `${actionPath}.viewpointId`);
        }
        if (value.when.type === "visitor-clicks-hotspot") {
          reference(
            value.when.targetHotspotId,
            ["hotspot"],
            scene.id,
            `${path}.interactions[${index}].when.targetHotspotId`,
          );
        }
      });

      // Disabled rules still need intact references so enabling them cannot revive broken data
      scene.rules.forEach((rule, index) => {
        const rulePath = `${path}.rules[${index}]`;
        const triggerPath = `${rulePath}.trigger`;
        const trigger = rule.trigger;
        switch (trigger.type) {
          case "click":
          case "gaze":
            reference(
              trigger.targetId,
              ["object", "hotspot", "navigationPoint"],
              scene.id,
              `${triggerPath}.targetId`,
            );
            break;
          case "zoneEnter":
            reference(trigger.zoneId, ["zone"], scene.id, `${triggerPath}.zoneId`);
            break;
          case "panelClose":
            reference(trigger.panelId, ["text", "image"], scene.id, `${triggerPath}.panelId`);
            break;
        }

        // Match each action to its allowed target kind without executing or rewriting the rule
        rule.actions.forEach((action, index) => {
          const actionPath = `${rulePath}.actions[${index}]`;
          switch (action.type) {
            case "showPanel":
              reference(action.panelId, ["text", "image"], scene.id, `${actionPath}.panelId`);
              break;
            case "playMedia":
              reference(action.mediaId, ["audio", "video"], scene.id, `${actionPath}.mediaId`);
              break;
            case "moveCamera":
              reference(action.viewpointId, ["viewpoint"], scene.id, `${actionPath}.viewpointId`);
              break;
            case "setVisible":
              reference(action.objectId, ["object"], scene.id, `${actionPath}.objectId`);
              break;
            case "navigateScene":
              destination(action.sceneId, action.viewpointId, actionPath);
              break;
          }
        });
      });
    });
    return { ok: true, value: project };
  } catch (error) {
    if (error instanceof ContentError) {
      return invalid(error.path, error.message);
    }
    throw error;
  }
}
