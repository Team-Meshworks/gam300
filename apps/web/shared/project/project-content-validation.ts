import type {
  ContentComponent,
  ContentProject,
  ProjectAction,
  ProjectTrigger,
  TextMark,
} from "./project-content";
import { MAX_PROJECT_BYTES } from "./project-limits";
import { validateCameraPose, validateTransform } from "./spatial-validation";
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
function record(raw: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(raw)) {
    fail(path, "Expected an object");
  }

  // Reject extra fields too, including server authority accidentally embedded in a file
  checked(checkFields(raw, fields, path));
  return raw;
}

// Match C# UTF-16 text limits and reject lone surrogates before JSON can replace them
function text(raw: unknown, path: string, limit = 256): string {
  if (typeof raw !== "string" || raw.length > limit) {
    fail(path, `Expected text with at most ${limit} characters`);
  }
  if (/[\ud800-\udfff]/u.test(raw)) {
    fail(path, "Text contains invalid Unicode");
  }
  return raw;
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
  record(raw, ["id", "type", ...variants[type]!], path);
  const id = text(raw.id, `${path}.id`);
  switch (type) {
    case "hotspot":
      return { id, type, label: text(raw.label, `${path}.label`) };
    case "text": {
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
      const url = text(raw.url, `${path}.url`, 2048);

      // Match the raw authority before URL can repair missing hosts or reinterpret credentials
      const authority =
        /^https:\/\/(\[[0-9a-fA-F:.]+\]|[^:/?#@]+)(?::([0-9]{1,5}))?(?=[/?#]|$)/.exec(url);
      let valid = false;
      try {
        if (authority) {
          // Decode only for validation; keep the original authored spelling in the returned document
          const host = decodeURIComponent(authority[1]!);
          const parsed = new URL(url);

          // Native URL parsing handles IPv6 and port range; DNS labels need the shared restrictions below
          const ipv6 = host.startsWith("[");
          const domain = parsed.hostname.replace(/\.$/, "");

          // Reject raw cleanup characters before accepting the parsed host
          // IPv6 bypasses DNS label checks while decoded DNS hosts must also exclude escaped delimiters
          valid =
            !Array.from(url).some(
              (character) =>
                character.charCodeAt(0) <= 32 ||
                character.charCodeAt(0) === 127 ||
                character === "\\",
            ) &&
            !parsed.username &&
            !parsed.password &&
            (ipv6 ||
              (!Array.from(host).some(
                (character) =>
                  character.charCodeAt(0) <= 32 ||
                  character.charCodeAt(0) === 127 ||
                  "%/\\?#@[]:<>^|".includes(character),
              ) &&
                domain.length <= 253 &&
                domain
                  .split(".")
                  .every((label) =>
                    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
                  )));

          // Browsers treat numeric suffixes as IPv4; forbid fallback DNS and legacy short or octal forms
          if (
            !ipv6 &&
            [host, domain].some((value) => /(?:^|\.)(?:[0-9]+|0[xX][0-9a-fA-F]*)\.?$/.test(value))
          ) {
            // Inspect authored octets because URL has already normalized legacy IPv4 spellings
            const parts = host.replace(/\.$/, "").split(".");
            valid &&=
              parts.length === 4 &&
              parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
          }
        }
      } catch {
        // Malformed percent escapes, IDN hosts and native parsing failures share the same field feedback
      }

      // All rejection paths point to the authored URL field; successful reads keep its spelling unchanged
      if (!valid) {
        fail(`${path}.url`, "Expected an absolute HTTPS URL without credentials");
      }
      return { type: "openLink", url };
    }
  }
}

export function validateContentStructure(raw: unknown): ValidationResult<ContentProject> {
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
      );
      return {
        id: text(scene.id, `${path}.id`),
        name: text(scene.name, `${path}.name`),
        environmentAssetId: text(scene.environmentAssetId, `${path}.environmentAssetId`),
        startCamera: checked(validateCameraPose(scene.startCamera, `${path}.startCamera`)),
        objects: list(scene.objects, `${path}.objects`, 200, (input, path) => {
          const object = record(
            input,
            ["id", "name", "assetId", "transform", "parentId", "visible", "components"],
            path,
          );
          return {
            id: text(object.id, `${path}.id`),
            name: text(object.name, `${path}.name`),
            assetId: text(object.assetId, `${path}.assetId`),
            transform: transform(object.transform, `${path}.transform`),
            parentId: parent(object.parentId, `${path}.parentId`),
            visible: flag(object.visible, `${path}.visible`),
            components: list(object.components, `${path}.components`, 16, component),
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
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PROJECT_BYTES) {
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
