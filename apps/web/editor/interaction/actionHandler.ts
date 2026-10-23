import type { EntityId } from "../../shared/project/project-types";

export const ACTIONS = Object.freeze([
  { type: "open-link", label: "Open a link" },
  { type: "play-audio", label: "Play this audio" },
  { type: "print-hi", label: "Print hi" },
] as const);

export type ActionType = (typeof ACTIONS)[number]["type"];
export type ActionDefinition = (typeof ACTIONS)[number];

export type Action = Readonly<{
  type: ActionType;
  targetObjectId: EntityId;
  url?: string;
}>;

let activeAudio: HTMLAudioElement | undefined;

export function runAction(action: Action): void {
  switch (action.type) {
    case "open-link":
      if (action.url !== undefined) window.open(action.url, "_blank", "noopener,noreferrer");
      return;
    case "play-audio":
      if (action.url !== undefined) playAudio(action.url);
      return;
    case "print-hi":
      console.log("hi");
      return;
  }
}

function playAudio(url: string): void {
  activeAudio?.pause();
  const audio = new Audio(url);
  activeAudio = audio;
  void audio.play().catch(() => {
    if (activeAudio === audio) activeAudio = undefined;
  });
}
