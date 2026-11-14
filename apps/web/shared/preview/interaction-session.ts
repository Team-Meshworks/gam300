import type {
  EntityId,
  Interaction,
  InteractionAction,
  ProjectHotspot,
} from "../project/project-types";
import { dispatchRules } from "./rule-dispatch";

type Action = InteractionAction;
export type ActionRunner = Readonly<{
  run(action: Action): boolean | void;
  runClicked?(action: Action): boolean | void;
  stop(): void;
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

export function createInteractionSession(
  interactions: readonly Interaction[],
  hotspots: readonly ProjectHotspot[],
  actions: ActionRunner,
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

  function execute(action: Action, deliberate = false): boolean {
    try {
      return (
        (deliberate && actions.runClicked ? actions.runClicked(action) : actions.run(action)) ===
        true
      );
    } catch {
      // One failed action must not prevent later actions from running
      return false;
    }
  }

  function run(): void {
    dispatchRules(
      interactions,
      (interaction) => interaction.when.type === "scene-starts",
      (interaction) => execute(interaction.do),
    );
  }

  return {
    sceneStarted() {
      run();
    },
    objectClicked(objectId) {
      beginEvent();
      dispatchRules(
        interactionsByObject.get(objectId.toLowerCase()) ?? [],
        () => true,
        (interaction) => execute(interaction.do, true),
      );
    },
    update(deltaSeconds) {
      if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
      elapsedSeconds += deltaSeconds;
      for (const interaction of interactions) {
        if (interaction.when.type !== "time-elapsed" || fired.has(interaction)) continue;
        if (elapsedSeconds < (interaction.when.seconds ?? 2)) continue;
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
