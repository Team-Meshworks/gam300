import type { EntityId, Interaction, ProjectHotspot } from "../../shared/project/project-types";
import { createActionRunner, type Action, type ActionRunner } from "./actionHandler";
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
  actions: ActionRunner = createActionRunner(),
  beginEvent: () => void = () => {},
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

  function execute(action: Action): boolean {
    try {
      return actions.run(action) === true;
    } catch {
      // One failed action must not prevent later actions from running
      return false;
    }
  }

  function run(event: TriggerEvent): void {
    for (const interaction of interactions) {
      if (triggerMatches(interaction.when, event) && execute(interaction.do)) break;
    }
  }

  return {
    sceneStarted() {
      run({ type: "scene-starts" });
    },
    objectClicked(objectId) {
      beginEvent();
      for (const interaction of interactionsByObject.get(objectId.toLowerCase()) ?? []) {
        if (execute(interaction.do)) break;
      }
    },
    update(deltaSeconds) {
      if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
      elapsedSeconds += deltaSeconds;
      let started = false;
      for (const interaction of interactions) {
        if (interaction.when.type !== "time-elapsed" || fired.has(interaction)) continue;
        if (elapsedSeconds < triggerSeconds(interaction.when)) continue;
        if (!started) {
          beginEvent();
          started = true;
        }
        fired.add(interaction);
        if (execute(interaction.do)) break;
      }
    },
    reset() {
      elapsedSeconds = 0;
      fired.clear();
      actions.stop();
    },
  };
}
