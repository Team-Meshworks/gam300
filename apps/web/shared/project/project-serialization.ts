import { encodeProjectJson } from "./project-wire";
import { validateProject } from "./project-validation";
import type { ValidationResult } from "./validation-helpers";

// File exports are strict by default. Only browser recovery opts into unfinished link text.
// Turn authored project data into JSON for a later file or storage write
// Caller supplies the same trusted asset lookup used when opening a project
export function serializeProject(
  raw: unknown,
  assetKinds: ReadonlyMap<string, string>,
  options: { allowDraftLinks?: boolean } = {},
): ValidationResult<string> {
  // Check before encoding so invalid numbers can't silently become null in JSON
  // Errors keep their field paths for the save feedback
  const project = validateProject(raw, assetKinds, options);
  if (!project.ok) {
    return project;
  }

  // Validator builds the saved fields into a separate copy in a fixed order
  // Keep compact JSON to stay within the checked 5 MiB limit
  // Number encoding keeps the available precision; array order stays as authored
  // Omit empty extensions so an unchanged v1/v2 export still opens in released readers.
  return { ok: true, value: encodeProjectJson(project.value) };
}
