import { isPortableHttpsUrl, MAX_PORTABLE_URL_LENGTH } from "../../shared/project/portable-url";
import type { InteractionAction } from "../../shared/project/project-types";

export const ACTIONS = Object.freeze([
  { type: "open-link", label: "Open a link" },
  { type: "play-audio", label: "Play this audio" },
  { type: "print-hi", label: "Show an alert" },
] as const);

export type ActionType = (typeof ACTIONS)[number]["type"];
export type ActionDefinition = (typeof ACTIONS)[number];

export type Action = InteractionAction;

// Each preview session owns its playback, so stopping one never touches another
export type ActionRunner = Readonly<{
  run(action: Action): void;
  stop(): void;
}>;

export function createActionRunner(): ActionRunner {
  let activeAudio: HTMLAudioElement | undefined;

  function stop(): void {
    activeAudio?.pause();
    activeAudio = undefined;
  }

  function playAudio(url: string): void {
    stop();
    const audio = new Audio(url);
    activeAudio = audio;
    void audio.play().catch(() => {
      if (activeAudio === audio) activeAudio = undefined;
    });
  }

  return {
    run(action) {
      switch (action.type) {
        case "open-link":
          if (action.url !== undefined) openInNewTab(action.url);
          return;
        case "play-audio":
          if (action.url !== undefined) playAudio(action.url);
          return;
        case "print-hi":
          window.alert("hi");
          return;
      }
    },
    stop,
  };
}

function openInNewTab(url: string): void {
  if (url.length > MAX_PORTABLE_URL_LENGTH || !isPortableHttpsUrl(url)) return;
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}
