import { validateProject } from "./project-validation";
import type { ValidationResult } from "./validation-helpers";

// Turn authored project data into JSON for a later file or storage write
// Caller supplies the same trusted asset lookup used when opening a project
export function serializeProject(
  raw: unknown,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<string> {
  // Check before encoding so invalid numbers can't silently become null in JSON
  // Errors keep their field paths for the save feedback
  const project = validateProject(raw, assetKinds);
  if (!project.ok) {
    return project;
  }

  // Validator builds the saved fields into a separate copy in a fixed order
  // Keep compact JSON to stay within the checked 5 MiB limit
  // Number encoding keeps the available precision; array order stays as authored
  return { ok: true, value: JSON.stringify(project.value) };
}
