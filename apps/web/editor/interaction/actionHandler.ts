import { isPortableHttpsUrl, MAX_PORTABLE_URL_LENGTH } from "../../shared/project/portable-url";
import type { InteractionAction } from "../../shared/project/project-types";

export const ACTIONS = Object.freeze([
  { type: "open-link", label: "Open a link" },
  { type: "play-audio", label: "Play this audio" },
  { type: "print-hi", label: "Show an alert" },
  { type: "navigate-scene", label: "Go to scene" },
  { type: "move-to-viewpoint", label: "Go to saved viewpoint" },
] as const);

export type ActionType = (typeof ACTIONS)[number]["type"];
export type ActionDefinition = (typeof ACTIONS)[number];

export type Action = InteractionAction;

// Each preview session owns its playback, so stopping one never touches another
export type ActionRunner = Readonly<{
  // True ends dispatch from the old scene after navigation.
  run(action: Action): boolean | void;
  stop(): void;
}>;

export type NavigationActions = Readonly<{
  goToScene(sceneId: string): boolean;
  goToViewpoint(viewpointId: string): void;
}>;

export function createActionRunner(
  navigation?: NavigationActions,
  resolveAudio?: (id: string) => { url: string; loop: boolean; volume: number } | undefined,
): ActionRunner {
  let activeAudio: HTMLAudioElement | undefined;
  let activeTrack: string | undefined;

  function stop(): void {
    activeAudio?.pause();
    activeAudio = undefined;
    activeTrack = undefined;
  }

  function playAudio(url: string, loop = false, volume = 1, trackId?: string): void {
    const key = trackId === undefined ? undefined : `${trackId.toLowerCase()}:${url}`;
    // Repeated Play actions keep the same track running; a replaced reference starts its new bytes
    if (key !== undefined && key === activeTrack && activeAudio) {
      if (activeAudio.ended) activeAudio.currentTime = 0;
      if (activeAudio.paused || activeAudio.ended) void activeAudio.play().catch(() => {});
      return;
    }
    stop();
    const audio = new Audio(url);
    audio.loop = loop;
    audio.volume = volume;
    activeAudio = audio;
    activeTrack = key;
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
          // Resolve from the current scene at playback time; replaced tracks keep their authored link
          if (action.mediaId !== undefined) {
            const source = resolveAudio?.(action.mediaId);
            if (source) playAudio(source.url, source.loop, source.volume, action.mediaId);
          } else if (action.url !== undefined) playAudio(action.url);
          return;
        case "navigate-scene":
          if (navigation?.goToScene(action.sceneId)) {
            stop();
            return true;
          }
          return;
        case "move-to-viewpoint":
          navigation?.goToViewpoint(action.viewpointId);
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
