import { missingProjectCapabilities } from "../project/project-capabilities";
import capabilities from "../project/publication-capabilities.json";
import type { CatalogueAsset } from "../asset-runtime/catalogue";
import type { ProjectDocument } from "../project/project-types";
import type { ProjectDocument as OlderSceneDocument } from "../project/legacy-scene-types";

export type PlayerSnapshot = Readonly<{
  document: ProjectDocument | OlderSceneDocument;
  assets: readonly CatalogueAsset[];
}>;

export function playbackIssue(document: PlayerSnapshot["document"]): string | undefined {
  // Check playback support after validation so saved rules and content stay intact
  // The server reads this same capability list before creating a publication
  if (document.schemaVersion === 2) {
    const missing = missingProjectCapabilities(document, new Set(capabilities));
    if (missing.length) {
      return `This exhibition requires unsupported features: ${missing.map((issue) => `${issue.capability} at ${issue.path}`).join(", ")}`;
    }
  }
  // URL-only audio has no immutable manifest entry; require a captured audio component instead
  if (
    document.scenes.some(
      (scene) =>
        "interactions" in scene &&
        scene.interactions.some(
          (item) => item.do.type === "play-audio" && item.do.url !== undefined,
        ),
    )
  ) {
    return "This exhibition audio must use an approved library track.";
  }
  return undefined;
}
