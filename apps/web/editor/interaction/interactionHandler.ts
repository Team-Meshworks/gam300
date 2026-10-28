import type { EntityId, Interaction, ProjectHotspot } from "../../shared/project/project-types";
import { runAction as runBrowserAction, type Action } from "./actionHandler";
import { triggerMatches, triggerSeconds, type TriggerEvent } from "./triggerHandler";

export type { Interaction } from "../../shared/project/project-types";

export type SceneInteractions = Readonly<{
  schemaVersion: 1;
  sceneId: EntityId;
  interactions: readonly Interaction[];
}>;

export type InteractionHandler = Readonly<{
  sceneStarted(): void;
  objectClicked(objectId: EntityId): void;
  update(deltaSeconds: number): void;
  reset(): void;
}>;

export function createInteractionHandler(
  interactions: readonly Interaction[],
  hotspots: readonly ProjectHotspot[],
  runAction: (action: Action) => void = runBrowserAction,
): InteractionHandler {
  let elapsedSeconds = 0;
  const fired = new Set<Interaction>();

  // Object -> hotspot -> rules keeps a click lookup proportional to the clicked
  // object's own hotspots instead of scanning every hotspot or interaction.
  const hotspotsByObject = new Map<EntityId, EntityId[]>();
  for (const hotspot of hotspots) {
    const attached = hotspotsByObject.get(hotspot.objectId);
    if (attached === undefined) hotspotsByObject.set(hotspot.objectId, [hotspot.id]);
    else attached.push(hotspot.id);
  }
  const interactionsByHotspot = new Map<EntityId, Interaction[]>();
  for (const interaction of interactions) {
    if (interaction.when.type !== "visitor-clicks-hotspot") continue;
    const target = interaction.when.targetHotspotId;
    const attached = interactionsByHotspot.get(target);
    if (attached === undefined) interactionsByHotspot.set(target, [interaction]);
    else attached.push(interaction);
  }

  function run(event: TriggerEvent): void {
    for (const interaction of interactions) {
      if (triggerMatches(interaction.when, event)) runAction(interaction.do);
    }
  }

  return {
    sceneStarted() {
      run({ type: "scene-starts" });
    },
    objectClicked(objectId) {
      const hotspotIds = hotspotsByObject.get(objectId);
      if (hotspotIds === undefined) return;
      for (const hotspotId of hotspotIds) {
        for (const interaction of interactionsByHotspot.get(hotspotId) ?? []) {
          runAction(interaction.do);
        }
      }
    },
    update(deltaSeconds) {
      if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
      elapsedSeconds += deltaSeconds;
      for (const interaction of interactions) {
        if (interaction.when.type !== "time-elapsed" || fired.has(interaction)) continue;
        if (elapsedSeconds < triggerSeconds(interaction.when)) continue;
        fired.add(interaction);
        runAction(interaction.do);
      }
    },
    reset() {
      elapsedSeconds = 0;
      fired.clear();
    },
  };
}
