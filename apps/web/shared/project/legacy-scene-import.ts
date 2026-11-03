import { readProjectJson } from "./project-deserialization";
import { validateProject as validateOlderSceneProject } from "./legacy-scene-validation";
import { validateProject } from "./project-validation";
import { invalid } from "./validation-helpers";
import type { ProjectDocument } from "./project-types";
import type { ValidationResult } from "./validation-helpers";

export function readOlderSceneFile(text: unknown, kinds: ReadonlyMap<string, string>) {
  const parsed = readProjectJson(text);
  return parsed.ok ? validateOlderSceneProject(parsed.value, kinds) : parsed;
}

// Conversion is only requested from the explicit older-file import UI. Standard Open
// and server validation remain strict, and the source file is never rewritten.
export function importOlderSceneFile(
  text: unknown,
  kinds: ReadonlyMap<string, string>,
  environments: Readonly<Record<string, string>> = {},
): ValidationResult<ProjectDocument> {
  const old = readOlderSceneFile(text, kinds);
  if (!old.ok) return old;
  const scenes = [];
  for (const [index, scene] of old.value.scenes.entries()) {
    const environmentAssetId = scene.environmentAssetId ?? environments[scene.id];
    if (!environmentAssetId)
      return invalid(
        `project.scenes[${index}].environmentAssetId`,
        `Choose an environment for ${scene.name}`,
      );
    const views = scene.viewpoints ?? [];
    const starting = views.find((view) => view.id === scene.startViewpointId) ?? views[0];
    scenes.push({
      id: scene.id,
      name: scene.name,
      environmentAssetId,
      startCamera: starting?.camera ?? scene.startCamera,
      viewpoints: views,
      groups: [],
      zones: [],
      rules: [],
      objects: scene.objects.map((object) => ({
        ...object,
        parentId: null,
        visible: true,
        components: [],
      })),
    });
  }
  return validateProject({ ...old.value, schemaVersion: 2, scenes }, kinds);
}
