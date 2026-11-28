import { AssetFilterSelect } from "./ui/AssetFilterSelect";
import { Icon as EditorIcon } from "./ui/Icon";
import { Button } from "../shared/ui/Button";
import { Icon } from "@iconify/react/offline";
import chevronDown from "@iconify-icons/lucide/chevron-down";
import trashIcon from "@iconify-icons/ant-design/delete-outlined";
import { useState } from "react";
import type { ProjectScene } from "../shared/project/project-types";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { playUiSound } from "./audio/ui-sounds";
import type { createDocumentStore } from "./document-store";
import "./saved-views.css";

export function Scenes({
  scenes,
  activeSceneId,
  assets,
  existingAssets = assets,
  store,
  disabled,
  onSwitch,
}: {
  scenes: readonly ProjectScene[];
  activeSceneId: string | null;
  assets: readonly CatalogueAsset[];
  existingAssets?: readonly CatalogueAsset[];
  store: ReturnType<typeof createDocumentStore>;
  disabled: boolean;
  onSwitch: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingFrom, setDeletingFrom] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const active = scenes.find((scene) => scene.id === activeSceneId);
  const selectedScene = selected === activeSceneId ? active : undefined;
  const deletingScene =
    deletingFrom === activeSceneId ? scenes.find((scene) => scene.id === deleting) : undefined;
  const renaming = editing === activeSceneId ? editing : null;
  const environments = assets.filter((asset) => asset.kind === "environment");
  const newEnvironment =
    environments.find((asset) => asset.id === active?.environmentAssetId)?.id ??
    environments[0]?.id;
  const retainedEnvironment = existingAssets.find(
    (asset) => asset.kind === "environment" && asset.id === active?.environmentAssetId,
  );
  function report(result: ReturnType<typeof store.switchScene>, success: string) {
    setMessage(result.ok ? success : result.error.message);
    setError(!result.ok);
  }
  function clearDrag() {
    setDragged(null);
    setDrop(null);
  }
  function move(id: string, index: number) {
    if (!disabled) report(store.moveScene(id, index), "Scene order updated. Undo is available.");
  }
  function choose(scene: ProjectScene) {
    if (disabled || renaming) return;
    const result = store.switchScene(scene.id);
    if (result.ok) {
      onSwitch();
      setSelected(scene.id);
      setDeleting(null);
    }
    report(result, `Editing ${scene.name}.`);
  }
  function rename(scene: ProjectScene, value: string) {
    if (disabled) return;
    const result = store.renameScene(scene.id, value);
    report(result, "Scene renamed. Undo is available.");
    if (result.ok) setEditing(null);
  }
  return (
    <section className="saved-views-panel scene-list-panel" aria-label="Scenes">
      <p className="saved-views-description">
        Each scene holds its own environment, objects and saved views.
      </p>
      <fieldset disabled={disabled}>
        <ol
          aria-label="Scenes in order"
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              setDrop(null);
          }}
        >
          {scenes.map((scene, index) => (
            <li
              key={scene.id}
              className={drop?.id === scene.id ? (drop.after ? "drop-after" : "drop-before") : ""}
              onDragOver={(event) => {
                if (!dragged || disabled) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const bounds = event.currentTarget.getBoundingClientRect();
                setDrop({ id: scene.id, after: event.clientY >= bounds.top + bounds.height / 2 });
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = scenes.findIndex((entry) => entry.id === dragged);
                if (dragged && from >= 0 && !disabled) {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const slot = index + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0);
                  move(dragged, slot > from ? slot - 1 : slot);
                }
                clearDrag();
              }}
            >
              <Button
                variant="quiet"
                className="saved-view-grip"
                aria-label={`Reorder scene ${scene.name}`}
                title="Drag to reorder; use arrow keys to move"
                draggable={!disabled && !renaming}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  const next = index + (event.key === "ArrowUp" ? -1 : 1);
                  if (next >= 0 && next < scenes.length) move(scene.id, next);
                }}
                onDragStart={(event) => {
                  if (disabled || renaming) {
                    event.preventDefault();
                    return;
                  }
                  setDragged(scene.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-spatia-scene", scene.id);
                }}
                onDragEnd={clearDrag}
              >
                <EditorIcon name="dragHandle" />
              </Button>
              <div className="saved-view-card" data-selected={selected === scene.id}>
                {renaming === scene.id ? (
                  <label className="saved-view-name-edit">
                    <span>{index + 1}.</span>
                    <input
                      className="tree-rename"
                      aria-label="Scene name"
                      autoFocus
                      maxLength={120}
                      value={name}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setName(event.target.value)}
                      onBlur={(event) => rename(scene, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditing(null);
                          setName(scene.name);
                        }
                      }}
                    />
                  </label>
                ) : (
                  <button
                    type="button"
                    className="saved-view-name scene-name"
                    aria-pressed={scene.id === activeSceneId}
                    title="Double-click to rename; press F2 to rename"
                    onClick={() => choose(scene)}
                    onDoubleClick={() => {
                      setSelected(scene.id);
                      setName(scene.name);
                      setEditing(scene.id);
                      setDeleting(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        setSelected(scene.id);
                        setName(scene.name);
                        setEditing(scene.id);
                        setDeleting(null);
                      }
                    }}
                  >
                    {index + 1}. {scene.name}
                  </button>
                )}
                <Button
                  variant="quiet"
                  className="saved-view-delete"
                  aria-label={`Delete scene ${scene.name}`}
                  disabled={scenes.length <= 1 || renaming !== null}
                  title={
                    scenes.length <= 1 ? "Keep at least one scene in your project" : "Delete scene"
                  }
                  onClick={() => {
                    setDeletingFrom(activeSceneId);
                    setDeleting(scene.id);
                  }}
                >
                  <Icon icon={trashIcon} className="icon" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {selectedScene && !deletingScene && (
          <fieldset disabled={renaming !== null} className="scene-environment-field">
            <label>
              Environment
              <AssetFilterSelect
                label="Environment"
                value={selectedScene.environmentAssetId ?? ""}
                options={[
                  ...(retainedEnvironment &&
                  !environments.some((asset) => asset.id === retainedEnvironment.id)
                    ? [
                        {
                          value: retainedEnvironment.id,
                          label: `${retainedEnvironment.name} (retired)`,
                          disabled: true,
                        },
                      ]
                    : []),
                  ...environments.map((asset) => ({ value: asset.id, label: asset.name })),
                ]}
                onChange={(value) =>
                  report(store.setEnvironment(value), "Environment updated. Undo is available.")
                }
                icon={
                  <Icon icon={chevronDown} className="scene-select-chevron" aria-hidden="true" />
                }
                minWidth={0}
              />
            </label>
          </fieldset>
        )}
        {!deletingScene && (
          <button
            type="button"
            className="saved-view-add"
            disabled={!newEnvironment || scenes.length >= 16 || renaming !== null}
            onClick={() => {
              if (!newEnvironment) return;
              let number = scenes.length + 1;
              const names = new Set(scenes.map((scene) => scene.name));
              while (names.has(`Scene ${number}`)) number++;
              const result = store.createScene(`Scene ${number}`, newEnvironment);
              if (result.ok) {
                onSwitch();
                setSelected(null);
              }
              report(result, `Created Scene ${number}. Undo is available.`);
            }}
          >
            + Add Scene
          </button>
        )}
        {deletingScene && (
          <div className="saved-view-confirm" role="group" aria-label="Confirm scene deletion">
            <h3>Delete “{deletingScene.name}”?</h3>
            <p>Scene contents and linked navigation will be deleted. Undo restores everything.</p>
            <div className="saved-view-confirm-actions">
              <button type="button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="saved-view-confirm-delete"
                aria-label="Confirm delete scene"
                onClick={() => {
                  const result = store.deleteScene(deletingScene.id);
                  if (result.ok) {
                    setDeleting(null);
                    playUiSound("delete");
                    onSwitch();
                  }
                  report(
                    result,
                    "Scene and related navigation links deleted. Undo restores everything.",
                  );
                }}
              >
                Delete scene
              </button>
            </div>
          </div>
        )}
        {!newEnvironment && <p className="saved-views-empty">No environments are available.</p>}
      </fieldset>
      <p className={error ? "saved-views-status" : "sr-only"} role="status">
        {message}
      </p>
    </section>
  );
}
