import type { EntityId, InteractionTrigger } from "../../shared/project/project-types";

export const DEFAULT_ELAPSED_SECONDS = 2;

export const TRIGGERS = Object.freeze([
  { type: "visitor-clicks-hotspot", label: "The visitor clicks this hotspot's object" },
  { type: "scene-starts", label: "The scene starts" },
  { type: "time-elapsed", label: "A set time has passed" },
] as const);

export type TriggerType = (typeof TRIGGERS)[number]["type"];
export type TriggerDefinition = (typeof TRIGGERS)[number];

export type Trigger = InteractionTrigger;

export type TriggerEvent =
  | Readonly<{ type: "visitor-clicks-hotspot"; hotspotId: EntityId }>
  | Readonly<{ type: "scene-starts" }>
  | Readonly<{ type: "time-elapsed" }>;

export function triggerMatches(trigger: Trigger, event: TriggerEvent): boolean {
  switch (trigger.type) {
    case "visitor-clicks-hotspot":
      return event.type === "visitor-clicks-hotspot" && trigger.targetHotspotId === event.hotspotId;
    case "scene-starts":
      return event.type === "scene-starts";
    case "time-elapsed":
      return event.type === "time-elapsed";
  }
}

export function triggerSeconds(trigger: Trigger): number {
  return trigger.type === "time-elapsed" ? (trigger.seconds ?? DEFAULT_ELAPSED_SECONDS) : 0;
}
