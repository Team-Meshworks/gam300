import type { MouseEvent } from "react";
import { loadSettings } from "../ui/user-settings";
import assetPlace from "./sounds/asset-place.wav";
import assetSelect from "./sounds/asset-select.wav";
import deleted from "./sounds/delete.wav";
import enterPreview from "./sounds/enter-preview.wav";
import goingBack from "./sounds/going-back.wav";
import publish from "./sounds/publish-success.wav";
import save from "./sounds/save.wav";
import warning from "./sounds/warning.wav";

// To add a sound put the file in ./sounds, import it above and name it here
const sounds = {
  assetPlace,
  assetSelect,
  delete: deleted,
  enterPreview,
  goingBack,
  publish,
  save,
  warning,
};

export type UiSound = keyof typeof sounds;

// Settings pop up changes this, every page starts from what was saved
let volume = loadSettings().volume;
// Long enough to hear the sound start, short enough that leaving still feel instant
const leaveDelayMs = 150;

const players = new Map<UiSound, HTMLAudioElement>();

// Made on first use so a page only downloads the sounds it can actually play
function playerFor(name: UiSound) {
  let player = players.get(name);
  if (player === undefined) {
    player = new Audio(sounds[name]);
    player.volume = volume;
    players.set(name, player);
  }
  return player;
}

// Call once from a page entry so the first click isnt late
export function preloadUiSounds(...names: UiSound[]) {
  for (const name of names) playerFor(name).preload = "auto";
}

// Sounds already made change too, not only new ones
export function setUiSoundVolume(next: number) {
  volume = next;
  for (const player of players.values()) player.volume = next;
}
export function playUiSound(name: UiSound) {
  const player = playerFor(name);
  player.currentTime = 0;
  // Browser can refuse to play, the click should still work without its sound
  player.play().catch(() => undefined);
}

// Going to another page stop any sound, so hold the page change back a little
export function leaveWithUiSound(name: UiSound, href: string) {
  playUiSound(name);
  window.setTimeout(() => location.assign(href), leaveDelayMs);
}

export function leaveLinkWithUiSound(name: UiSound, event: MouseEvent<HTMLAnchorElement>) {
  // These open a new tab or window, this page stay so the link can do its normal thing
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  leaveWithUiSound(name, event.currentTarget.href);
}
