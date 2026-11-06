export type Theme = "light" | "dark";

// What each person sets in the Settings pop up. Kept in this browser only, not in the project
export type UserSettings = {
  theme: Theme;
  // Editor click sounds, 0 is silent and 1 is full
  volume: number;
};

export const defaultSettings: UserSettings = { theme: "light", volume: 0.5 };

const storageKey = "spatia-user-settings";

// Anything unknown or out of range falls back to the default
export function readSettings(value: unknown): UserSettings {
  const saved =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<keyof UserSettings, unknown>>)
      : {};
  return {
    theme: saved.theme === "dark" ? "dark" : "light",
    volume:
      typeof saved.volume === "number" && Number.isFinite(saved.volume)
        ? Math.min(1, Math.max(0, saved.volume))
        : defaultSettings.volume,
  };
}

// Storage can be blocked or hold junk from an older version, then use the defaults
export function loadSettings(): UserSettings {
  try {
    return readSettings(JSON.parse(localStorage.getItem(storageKey) ?? "{}"));
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: UserSettings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // Nothing to do, the settings still apply for this visit
  }
}

let themeTimer: number | undefined;

// styles.css swaps its colours on this attribute. Switching, but not the first load, eases the
// colours across for a moment instead of snapping
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  if (root.dataset.theme !== undefined) {
    root.classList.add("theme-changing");
    window.clearTimeout(themeTimer);
    themeTimer = window.setTimeout(() => root.classList.remove("theme-changing"), 250);
  }
  root.dataset.theme = theme;
}
