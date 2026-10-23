import type { EntityId } from "../../shared/project/project-types";
import { runAction as runBrowserAction, type Action } from "./actionHandler";
import { triggerMatches, triggerSeconds, type Trigger, type TriggerEvent } from "./triggerHandler";

export type Interaction = Readonly<{
  when: Trigger;
  do: Action;
}>;

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
  runAction: (action: Action) => void = runBrowserAction,
): InteractionHandler {
  let elapsedSeconds = 0;
  const fired = new Set<Interaction>();

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
      run({ type: "visitor-clicks-object", objectId });
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
