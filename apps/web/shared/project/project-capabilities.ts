import type { ProjectDocument } from "./project-types";

export type CapabilityIssue = Readonly<{ path: string; capability: string }>;

// Validate and retain known content separately from a player's ability to execute it
export function missingProjectCapabilities(
  project: ProjectDocument,
  supported: ReadonlySet<string>,
): CapabilityIssue[] {
  // The released v1 format uses baseline model viewing and needs no extra player features
  // Import validation must finish before this execution-support check
  if (project.schemaVersion === 1) {
    return [];
  }
  const content = project;

  // Collect missing features without editing the document so unsupported content remains saveable
  const issues: CapabilityIssue[] = [];
  function need(capability: string, path: string) {
    // Retain every unsupported location so callers can identify all affected authored content
    if (!supported.has(capability)) {
      issues.push({ path, capability });
    }
  }

  // A player that only opens the first scene cannot execute the complete multi-scene project
  if (content.scenes.length > 1) {
    need("multipleScenes", "project.scenes");
  }
  content.scenes.forEach((scene, sceneIndex) => {
    // Inspect content first, then enabled rules; report locations in the original authored arrays
    const path = `project.scenes[${sceneIndex}]`;
    scene.objects.forEach((object, objectIndex) => {
      const objectPath = `${path}.objects[${objectIndex}]`;
      // Hidden objects need explicit support; visible objects match the baseline player behavior
      if (!object.visible) {
        need("visibility", `${objectPath}.visible`);
      }

      // Components require their content player plus any more specific playback features
      object.components.forEach((component, index) => {
        const path = `${objectPath}.components[${index}]`;
        need(`content:${component.type}`, path);
        // Global playback and spatial attenuation are separate audio capabilities
        if (component.type === "audio") {
          need(`audio:${component.mode}`, `${path}.mode`);
        }

        // Inspect each text mark without interpreting the authored strings as markup
        if (component.type === "text") {
          component.runs.forEach((run, index) => {
            run.marks.forEach((mark, markIndex) =>
              need(`text:${mark}`, `${path}.runs[${index}].marks[${markIndex}]`),
            );
          });
        }
      });
    });
    scene.rules.forEach((rule, index) => {
      // Keep disabled rules saved without requiring a player to execute their variants
      if (!rule.enabled) {
        return;
      }

      // The trigger and every ordered action must be available before this rule can run
      const rulePath = `${path}.rules[${index}]`;
      need(`trigger:${rule.trigger.type}`, `${rulePath}.trigger`);
      rule.actions.forEach((action, index) =>
        need(`action:${action.type}`, `${rulePath}.actions[${index}]`),
      );
    });
  });
  // An empty list allows execution; this check never changes saved content or starts playback
  return issues;
}
