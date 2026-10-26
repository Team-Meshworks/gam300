export const ACTIONS = Object.freeze([
  { type: "open-link", label: "Open a link" },
  { type: "play-audio", label: "Play this audio" },
  { type: "print-hi", label: "Show an alert" },
] as const);

export type ActionType = (typeof ACTIONS)[number]["type"];
export type ActionDefinition = (typeof ACTIONS)[number];

export type Action =
  | Readonly<{ type: "open-link"; url?: string }>
  | Readonly<{ type: "play-audio"; url?: string }>
  | Readonly<{ type: "print-hi" }>;

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
      window.alert("hi");
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
