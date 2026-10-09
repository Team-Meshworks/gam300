import { MAX_JSON_DEPTH, MAX_PROJECT_BYTES } from "./project-limits";
import type { ProjectDocument } from "./project-types";
import { validateProject } from "./project-validation";
import { invalid } from "./validation-helpers";
import type { ValidationResult } from "./validation-helpers";

function exceedsNestingLimit(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;

  // Scan without building an object tree
  // Brackets inside names are just text, including after an escaped quote
  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) return true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      // An extra closing bracket already makes the JSON invalid
      // Leave syntax errors to JSON.parse
      if (depth < 0) return false;
    }
  }
  return false;
}

// Read JSON text into a separate validated project
// Caller replaces the open project only after an ok result
// File upload code must also check File.size before reading its text
export function deserializeProject(
  text: unknown,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<ProjectDocument> {
  if (typeof text !== "string") {
    return invalid("project", "Expected project JSON text");
  }

  // Reject huge strings before allocating the UTF-8 byte buffer
  // Count the original text, including indentation and trailing whitespace
  if (
    text.length > MAX_PROJECT_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_PROJECT_BYTES
  ) {
    return invalid("project", "Project JSON exceeds the 5 MiB file limit");
  }
  if (exceedsNestingLimit(text)) {
    return invalid("project", `Project JSON exceeds the nesting limit of ${MAX_JSON_DEPTH}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // Keep parser excerpts out of feedback; they can contain authored text
    if (error instanceof SyntaxError) {
      return invalid("project", "Project JSON is malformed");
    }
    throw error;
  }

  // Version, IDs and asset references go through the same checks as saving
  return validateProject(raw, assetKinds);
}
