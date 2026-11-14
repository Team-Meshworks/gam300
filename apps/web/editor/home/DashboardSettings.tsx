import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import settingsIcon from "@iconify-icons/bytesize/settings";
import moon from "@iconify-icons/lucide/moon";
import sun from "@iconify-icons/lucide/sun";
import speaker from "@iconify-icons/bi/speaker-fill";
import { SettingsPanel } from "../ui/SettingsPanel";
import { applyTheme, loadSettings, saveSettings } from "../ui/user-settings";

export function DashboardSettings() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div className="settings-anchor">
      <button
        type="button"
        className="sp-dashboard-settings"
        ref={trigger}
        aria-label="Settings"
        title="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="settings-panel"
        onClick={() => setOpen(!open)}
      >
        <Icon icon={settingsIcon} width={20} />
      </button>
      {open && (
        <SettingsPanel
          settings={settings}
          onClose={close}
          icon={(name) => (
            <Icon icon={name === "sun" ? sun : name === "moon" ? moon : speaker} className="icon" />
          )}
          onSave={(next) => {
            saveSettings(next);
            setSettings(next);
            close();
          }}
        />
      )}
    </div>
  );
}
