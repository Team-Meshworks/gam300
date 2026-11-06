import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { playUiSound, setUiSoundVolume } from "../audio/ui-sounds";
import { Icon } from "./Icon";
import { applyTheme, type UserSettings } from "./user-settings";
import "./settings-panel.css";

function show(settings: UserSettings) {
  applyTheme(settings.theme);
  setUiSoundVolume(settings.volume);
}

// Drops down under the Settings button. Changes show straight away so they can be tried,
// Save Changes keeps them and closing any other way puts the saved ones back
export function SettingsPanel({
  settings,
  onSave,
  onClose,
}: {
  settings: UserSettings;
  onSave: (settings: UserSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const panel = useRef<HTMLElement>(null);
  // What was saved when it opened, and whether Save Changes was pressed
  const original = useRef(settings);
  const saved = useRef(false);
  const dark = draft.theme === "dark";
  const percent = Math.round(draft.volume * 100);

  useEffect(() => {
    show(draft);
  }, [draft]);

  // Lined up with the button it can run off the left on a phone, Preview and Publish sit to its
  // right, so nudge it back inside the window
  useLayoutEffect(() => {
    const element = panel.current;
    if (element === null) return;
    function fit() {
      if (element === null) return;
      element.style.translate = "";
      const box = element.getBoundingClientRect();
      const margin = 16;
      const shift =
        Math.max(margin - box.left, 0) + Math.min(window.innerWidth - margin - box.right, 0);
      element.style.translate = shift === 0 ? "" : `${shift}px 0`;
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Cancel, Esc, clicking away or the Settings button all close it, every way undoes the try out
  useEffect(
    () => () => {
      if (!saved.current) show(original.current);
    },
    [],
  );

  useEffect(() => {
    // Clicking outside (either button) closes it, without that click also reaching the scene.
    // The Settings button toggles it itself
    function closeOutside(event: PointerEvent) {
      if (!(event.target instanceof Element)) return;
      if (panel.current?.contains(event.target)) return;
      if (event.target.closest('[aria-controls="settings-panel"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <section
      ref={panel}
      id="settings-panel"
      className="settings-dialog"
      role="dialog"
      aria-label="Settings"
    >
      <h2 className="settings-heading">Appearance</h2>
      <button
        className="theme-toggle"
        type="button"
        role="switch"
        aria-checked={dark}
        aria-label="Dark mode"
        onClick={() => setDraft({ ...draft, theme: dark ? "light" : "dark" })}
      >
        <span className="theme-toggle-knob">
          <Icon name={dark ? "moon" : "sun"} />
        </span>
        {dark ? "Dark Mode" : "Light Mode"}
      </button>

      <h2 className="settings-heading">Audio</h2>
      <div className="settings-sound">
        <Icon name="soundEffects" />
        <label htmlFor="sound-effects-volume">Sound Effects</label>
        <output htmlFor="sound-effects-volume">{percent}%</output>
        <input
          id="sound-effects-volume"
          type="range"
          min={0}
          max={100}
          value={percent}
          style={{ "--fill": `${percent}%` } as CSSProperties}
          onChange={(event) =>
            setDraft({ ...draft, volume: Number(event.currentTarget.value) / 100 })
          }
          // A click at the new level so you can hear how loud it is
          onPointerUp={() => playUiSound("assetSelect")}
        />
      </div>

      <div className="settings-actions">
        <button className="ui-button pill-button" type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="ui-button pill-button"
          type="button"
          onClick={() => {
            saved.current = true;
            onSave(draft);
          }}
        >
          Save Changes
        </button>
      </div>
    </section>
  );
}
