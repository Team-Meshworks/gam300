import type { SceneObject } from "../../shared/project/scene-object";
import type { Interaction, ProjectHotspot } from "../../shared/project/project-types";

// Keyboard and screen-reader users reach the same object click the canvas sends
export function PreviewTargets({
  objects,
  hotspots,
  interactions,
  onActivate,
}: {
  objects: readonly SceneObject[];
  hotspots: readonly ProjectHotspot[];
  interactions: readonly Interaction[];
  onActivate: (objectId: string) => void;
}) {
  const objectByHotspot = new Map(
    hotspots.map((hotspot) => [hotspot.id.toLowerCase(), hotspot.objectId.toLowerCase()]),
  );
  const clickable = new Set<string>();
  for (const interaction of interactions) {
    if (interaction.when.type !== "visitor-clicks-hotspot") continue;
    const objectId = objectByHotspot.get(interaction.when.targetHotspotId.toLowerCase());
    if (objectId !== undefined) clickable.add(objectId);
  }
  const targets = objects.filter((object) => clickable.has(object.id.toLowerCase()));
  if (targets.length === 0) return null;

  return (
    <nav className="preview-targets" aria-label="Interactive objects">
      <ul role="list">
        {targets.map((object) => (
          <li key={object.id}>
            <button
              className="ui-button panel-pill"
              type="button"
              data-object-id={object.id}
              onClick={() => onActivate(object.id)}
            >
              {object.name}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
