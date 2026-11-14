import type { Interaction, ProjectHotspot } from "../../shared/project/project-types";
import { createInteractionSession } from "../../shared/preview/interaction-session";
import { createActionRunner, type ActionRunner } from "./actionHandler";

export type { Interaction } from "../../shared/project/project-types";
export type {
  InteractionHandler,
  SceneInteractions,
} from "../../shared/preview/interaction-session";

export function createInteractionHandler(
  interactions: readonly Interaction[],
  hotspots: readonly ProjectHotspot[],
  actions: ActionRunner = createActionRunner(),
  beginEvent: () => void = () => {},
) {
  return createInteractionSession(interactions, hotspots, actions, beginEvent);
}
