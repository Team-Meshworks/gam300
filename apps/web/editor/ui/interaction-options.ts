import type { SceneObject } from "../../shared/project/scene-object";

// Only what the panel needs to show. Saving these and running them for visitors is done separately
export type TargetKind = "objects" | "hotspots" | "furniture" | "digital" | "media" | "seconds";
export type TriggerId = "click" | "enter" | "time" | "sit" | "look" | "start";
export type ActionId = "show" | "play" | "move" | "hide" | "nothing" | "lookAt";

// Targets are object ids, or the seconds for the timer. Empty means nothing picked yet
export type InteractionRule = {
  id: string;
  trigger: TriggerId;
  triggerTarget: string;
  action: ActionId;
  actionTarget: string;
};

export type Choice = { value: string; label: string };

export const triggers: readonly { id: TriggerId; label: string; target: TargetKind }[] = [
  { id: "click", label: "Visitor clicks this", target: "objects" },
  { id: "enter", label: "Visitor enters here", target: "hotspots" },
  { id: "time", label: "Seconds passed", target: "seconds" },
  { id: "sit", label: "Visitor sits here", target: "furniture" },
  { id: "look", label: "Visitor looks here", target: "objects" },
  { id: "start", label: "Scene starts here", target: "hotspots" },
];

export const actions: readonly { id: ActionId; label: string; target: TargetKind | null }[] = [
  { id: "show", label: "Show this", target: "digital" },
  { id: "play", label: "Play this", target: "media" },
  { id: "move", label: "Move here", target: "hotspots" },
  { id: "hide", label: "Hide this", target: "digital" },
  { id: "nothing", label: "Nothing", target: null },
  { id: "lookAt", label: "Look at this", target: "objects" },
];

export function triggerKind(id: TriggerId): TargetKind {
  return triggers.find((trigger) => trigger.id === id)?.target ?? "objects";
}

export function actionKind(id: ActionId): TargetKind | null {
  return actions.find((action) => action.id === id)?.target ?? null;
}

// Hotspots, furniture, digital and media cant be placed yet, so those lists stay empty for now
export function targetChoices(
  kind: TargetKind | null,
  objects: readonly Pick<SceneObject, "id" | "name">[],
): Choice[] {
  if (kind === "seconds") {
    return [5, 10, 15].map((seconds) => ({ value: String(seconds), label: `${seconds} seconds` }));
  }
  if (kind === "objects")
    return objects.map((object) => ({ value: object.id, label: object.name }));
  return [];
}

// Changing the trigger or action also change what the pill can pick, so start from its first choice
export function withTrigger(
  rule: InteractionRule,
  trigger: TriggerId,
  objects: readonly Pick<SceneObject, "id" | "name">[],
): InteractionRule {
  const first = targetChoices(triggerKind(trigger), objects)[0];
  return { ...rule, trigger, triggerTarget: first?.value ?? "" };
}

export function withAction(
  rule: InteractionRule,
  action: ActionId,
  objects: readonly Pick<SceneObject, "id" | "name">[],
): InteractionRule {
  const first = targetChoices(actionKind(action), objects)[0];
  return { ...rule, action, actionTarget: first?.value ?? "" };
}

export function newInteraction(
  id: string,
  objects: readonly Pick<SceneObject, "id" | "name">[],
): InteractionRule {
  const blank: InteractionRule = {
    id,
    trigger: "click",
    triggerTarget: "",
    action: "show",
    actionTarget: "",
  };
  return withAction(withTrigger(blank, "click", objects), "show", objects);
}
