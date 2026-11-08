import { useEffect, useRef, type ReactNode } from "react";
import sampleProject from "../../shared/project/fixtures/m1-project.json";
import type { CameraView } from "../graphics/modeManager";
import type { useProjectSession } from "../persistence/use-project-session";
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
  serverMode = false,
  serverSaving = false,
  onLeave,
  onPublish,
  onReview,
  hasProject,
  hasChanges,
  ready,
  visitor,
  switching,
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
  session: ReturnType<typeof useProjectSession>;
  serverMode?: boolean;
  serverSaving?: boolean;
  onLeave?: (() => void) | undefined;
  onPublish?: (() => void) | undefined;
  onReview?: (() => void) | undefined;
  hasProject: boolean;
  hasChanges: boolean;
  ready: boolean;
  visitor: boolean;
  switching: boolean;
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

  const busy = session.operation !== null;
  const saveState: SaveState =
    serverSaving || session.operation === "file"
      ? "saving"
      : session.fileFailed
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
          aria-label={serverMode ? "Leave editor" : "Back to projects (coming soon)"}
          onClick={onLeave}
          aria-disabled={!serverMode}
          title={serverMode ? "Leave editor" : "Back to projects (coming soon)"}
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
            <span className="project-name">{session.fileName || "Untitled project"}</span>
            <Icon name="caretDown" />
          </summary>
          <div className="draft-menu-panel">
            {!serverMode && (
              <>
                <button
                  type="button"
                  title="Start a new project and choose a room"
                  disabled={!ready || busy}
                  onClick={() => {
                    closeMenu();
                    void session.createNew();
                  }}
                >
                  New
                </button>
                <button
                  type="button"
                  title="Open a JSON project file"
                  disabled={!ready || busy}
                  onClick={() => {
                    closeMenu();
                    void session.open();
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  disabled={!ready || busy}
                  onClick={() => {
                    closeMenu();
                    document.getElementById("older-scene-import")?.click();
                  }}
                >
                  Import older scene file
                </button>
                {session.olderSceneFiles.map((file, index) => (
                  <button
                    key={index}
                    type="button"
                    disabled={!ready || busy}
                    onClick={() => {
                      closeMenu();
                      document.getElementById(`older-recovery-import-${index}`)?.click();
                    }}
                  >
                    Import older browser backup
                    {session.olderSceneFiles.length > 1 ? ` ${index + 1}: ${file.name}` : ""}
                  </button>
                ))}
              </>
            )}
            {/* Ctrl+S clicks these two by id, so dont change the ids */}
            <button
              id="project-save"
              type="button"
              title={
                hasProject
                  ? serverMode
                    ? "Save to server"
                    : "Save changes to the current file · Ctrl+S"
                  : "Choose a room to create your project"
              }
              disabled={!hasProject || busy}
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
              title={
                hasProject
                  ? "Choose a filename and folder · Ctrl+Shift+S"
                  : "Choose a room to create your project"
              }
              disabled={!hasProject || busy}
              onClick={() => {
                closeMenu();
                void session.save(true);
              }}
            >
              {serverMode ? "Export project file" : "Save As"}
            </button>
          </div>
        </details>
        {hasChanges && (
          // Server sessions use confirmed server state; local sessions use the file baseline
          <span
            className="save-state"
            data-state={saveState}
            title={
              serverMode
                ? saveLabels[saveState]
                : session.dirty
                  ? "Changes have not been saved to the JSON file"
                  : "Project matches the last opened or saved JSON file"
            }
            role="status"
          >
            <Icon name={saveState === "saved" ? "cloudSaved" : "cloud"} />
            <span className="sr-only">{saveLabels[saveState]}</span>
          </span>
        )}
      </div>

      <div
        className="history-controls"
        role="group"
        aria-label="History"
        inert={visitor || switching}
      >
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
        {import.meta.env.DEV && !visitor && !serverMode && (
          <button
            className="dev-action"
            type="button"
            disabled={!ready || busy}
            onClick={() => void session.openSample(sampleProject)}
          >
            Open sample project
          </button>
        )}
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
        {!visitor && onReview && (
          <button
            className="ui-button pill-button"
            type="button"
            disabled={!ready || busy}
            onClick={onReview}
          >
            Review
          </button>
        )}
        {!visitor && onPublish && (
          <button
            className="ui-button pill-button is-primary"
            type="button"
            disabled={!ready || busy}
            title="Review and publish this student's project"
            onClick={onPublish}
          >
            Publish
          </button>
        )}
      </div>
    </header>
  );
}
