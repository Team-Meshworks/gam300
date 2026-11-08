import { useEffect, useRef, type ReactNode } from "react";
import type { CameraView } from "../graphics/modeManager";
import type { ServerEditorSession } from "../App";
import { Icon } from "./Icon";

type SaveState = "saving" | "failed" | "pending" | "saved";

const saveLabels: Record<SaveState, string> = {
  saving: "Saving…",
  failed: "Save failed",
  pending: "Not saved",
  saved: "Saved",
};

export function TopBar({
  session,
  ready,
  visitor,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  canPreview,
  onPreview,
  onExitPreview,
  view,
  onToggleView,
  settingsPanel,
  onSettings,
}: {
  session: ServerEditorSession;
  ready: boolean;
  visitor: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canPreview: boolean;
  onPreview: () => void;
  onExitPreview: () => void;
  view: CameraView;
  onToggleView: () => void;
  // The open settings panel, or null while it is closed
  settingsPanel: ReactNode;
  onSettings: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // Clicking back into the editor closes the project options
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) {
        menu.current?.removeAttribute("open");
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  function closeMenu() {
    menu.current?.removeAttribute("open");
    menu.current?.querySelector("summary")?.focus();
  }

  const busy = session.departing;
  const saveState: SaveState = session.saving
    ? "saving"
    : session.failed
      ? "failed"
      : session.dirty
        ? "pending"
        : "saved";

  return (
    <header className="app-header">
      <h1 className="sr-only">Spatia</h1>

      <div className="project-card" inert={visitor}>
        <button
          className="ui-button icon-button"
          type="button"
          aria-label="Leave editor"
          onClick={session.leave}
          title="Leave editor"
        >
          <Icon name="back" />
        </button>
        <span className="project-avatar" aria-hidden="true" />
        <details
          className="draft-menu"
          ref={menu}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu();
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              event.currentTarget.removeAttribute("open");
            }
          }}
        >
          <summary aria-label="Project options" title="Project options">
            <span className="project-name">{session.title}</span>
            <Icon name="caretDown" />
          </summary>
          <div className="draft-menu-panel">
            {/* Ctrl+S clicks these two by id, so dont change the ids */}
            <button
              id="project-save"
              type="button"
              title="Save to server · Ctrl+S"
              disabled={busy}
              onClick={() => {
                closeMenu();
                void session.save();
              }}
            >
              Save
            </button>
            <button
              id="project-save-as"
              type="button"
              title="Export project file · Ctrl+Shift+S"
              disabled={busy}
              onClick={() => {
                closeMenu();
                void session.save(true);
              }}
            >
              Export project file
            </button>
          </div>
        </details>
        <span
          className="save-state"
          data-state={saveState}
          title={saveLabels[saveState]}
          role="status"
        >
          <Icon name={saveState === "saved" ? "cloudSaved" : "cloud"} />
          <span className="sr-only">{saveLabels[saveState]}</span>
        </span>
      </div>

      <div className="history-controls" role="group" aria-label="History" inert={visitor || busy}>
        <button
          className="ui-button"
          type="button"
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo (Ctrl+Z / ⌘Z)"
          aria-keyshortcuts="Control+z Meta+z"
        >
          <Icon name="undo" />
          <span className="sr-only">Undo</span>
        </button>
        <button
          className="ui-button"
          type="button"
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo (Ctrl+Y / Ctrl+Shift+Z / ⌘⇧Z)"
          aria-keyshortcuts="Control+y Control+Shift+z Meta+Shift+z"
        >
          <Icon name="redo" />
          <span className="sr-only">Redo</span>
        </button>
      </div>

      <div className="mode-actions" role="group" aria-label="View and publish">
        {!visitor && (
          <button
            className="ui-button icon-button view-toggle"
            type="button"
            aria-label="Third person"
            aria-pressed={view === "third"}
            title={view === "third" ? "Back to first person" : "Third person · see the whole scene"}
            onClick={onToggleView}
          >
            <Icon name="overview" />
          </button>
        )}
        {!visitor && (
          // The panel drops down right under the button
          <div className="settings-anchor">
            <button
              className="ui-button icon-button"
              type="button"
              aria-label="Settings"
              aria-expanded={settingsPanel !== null}
              aria-controls="settings-panel"
              title="Settings"
              onClick={onSettings}
            >
              <Icon name="settings" />
            </button>
            {settingsPanel}
          </div>
        )}
        {visitor ? (
          <button className="ui-button pill-button" type="button" onClick={onExitPreview}>
            Exit preview
          </button>
        ) : (
          <button
            className="ui-button pill-button"
            type="button"
            disabled={!canPreview}
            title="Walk through the scene as a visitor"
            onClick={onPreview}
          >
            Preview
          </button>
        )}
        {!visitor && session.publish && (
          <button
            className="ui-button pill-button is-primary"
            type="button"
            disabled={!ready || busy}
            title="Publish this project"
            onClick={session.publish}
          >
            Publish
          </button>
        )}
      </div>
    </header>
  );
}
