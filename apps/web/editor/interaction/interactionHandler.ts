import type { EntityId, Interaction, ProjectHotspot } from "../../shared/project/project-types";
import { runAction as runBrowserAction, stopActiveAudio, type Action } from "./actionHandler";
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

  // UUIDs keep their authored spelling but compare case-insensitively at runtime.
  const objectByHotspot = new Map<string, string>();
  for (const hotspot of hotspots) {
    objectByHotspot.set(hotspot.id.toLowerCase(), hotspot.objectId.toLowerCase());
  }

  // Index in author order so clicks never reshuffle rules by hotspot
  const interactionsByObject = new Map<string, Interaction[]>();
  for (const interaction of interactions) {
    if (interaction.when.type !== "visitor-clicks-hotspot") continue;
    const objectId = objectByHotspot.get(interaction.when.targetHotspotId.toLowerCase());
    if (objectId === undefined) continue;
    const attached = interactionsByObject.get(objectId);
    if (attached === undefined) interactionsByObject.set(objectId, [interaction]);
    else attached.push(interaction);
  }

  function execute(action: Action): void {
    try {
      runAction(action);
    } catch {
      // One failed action must not prevent later actions from running
    }
  }

  function run(event: TriggerEvent): void {
    for (const interaction of interactions) {
      if (triggerMatches(interaction.when, event)) execute(interaction.do);
    }
  }

  return {
    sceneStarted() {
      run({ type: "scene-starts" });
    },
    objectClicked(objectId) {
      for (const interaction of interactionsByObject.get(objectId.toLowerCase()) ?? []) {
        execute(interaction.do);
      }
    },
    update(deltaSeconds) {
      if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
      elapsedSeconds += deltaSeconds;
      for (const interaction of interactions) {
        if (interaction.when.type !== "time-elapsed" || fired.has(interaction)) continue;
        if (elapsedSeconds < triggerSeconds(interaction.when)) continue;
        fired.add(interaction);
        execute(interaction.do);
      }
    },
    reset() {
      elapsedSeconds = 0;
      fired.clear();
      stopActiveAudio();
    },
  };
}
