import { useState } from "react";
import type { ProjectScene } from "../shared/project/project-types";
import type { CatalogueAsset } from "../shared/assets/catalogue";
import type { createDocumentStore } from "./document-store";

export function Scenes({
  scenes,
  activeSceneId,
  assets,
  store,
  disabled,
  onSwitch,
}: {
  scenes: readonly ProjectScene[];
  activeSceneId: string | null;
  assets: readonly CatalogueAsset[];
  store: ReturnType<typeof createDocumentStore>;
  disabled: boolean;
  onSwitch: () => void;
}) {
  const [name, setName] = useState(scenes.find((s) => s.id === activeSceneId)?.name ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const active = scenes.find((s) => s.id === activeSceneId);
  function report(result: ReturnType<typeof store.switchScene>, success: string) {
    setMessage(result.ok ? success : result.error.message);
  }
  function move(id: string, index: number) {
    if (!disabled) report(store.moveScene(id, index), "Scene order updated. Undo is available.");
  }
  return (
    <section className="scenes-panel" aria-label="Scenes">
      <h2>Scenes</h2>
      <p>Each scene holds its own environment, objects and saved views.</p>
      <fieldset disabled={disabled}>
        <ol
          aria-label="Scenes in order"
          onDragLeave={(e) => {
            if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget))
              setDrop(null);
          }}
        >
          {scenes.map((scene, index) => (
            <li
              key={scene.id}
              className={drop?.id === scene.id ? (drop.after ? "drop-after" : "drop-before") : ""}
              onDragOver={(e) => {
                if (!dragged || disabled) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                setDrop({ id: scene.id, after: e.clientY >= rect.top + rect.height / 2 });
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = scenes.findIndex((s) => s.id === dragged);
                if (dragged && from >= 0 && !disabled) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const slot = index + (e.clientY >= rect.top + rect.height / 2 ? 1 : 0);
                  move(dragged, slot > from ? slot - 1 : slot);
                }
                setDragged(null);
                setDrop(null);
              }}
            >
              <span
                className="view-drag-handle"
                title={`Drag to reorder ${scene.name}`}
                aria-hidden="true"
                draggable={!disabled}
                onDragStart={(e) => {
                  if (disabled) {
                    e.preventDefault();
                    return;
                  }
                  setDragged(scene.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("application/x-spatia-scene", scene.id);
                }}
                onDragEnd={() => {
                  setDragged(null);
                  setDrop(null);
                }}
              >
                {"\u283f"}
              </span>
              <button
                type="button"
                aria-pressed={scene.id === activeSceneId}
                onClick={() => {
                  const result = store.switchScene(scene.id);
                  if (result.ok) {
                    onSwitch();
                    setName(scene.name);
                  }
                  report(result, `Editing ${scene.name}.`);
                }}
              >
                {index + 1}. {scene.name}
              </button>
            </li>
          ))}
        </ol>
        <label>
          Scene name
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="viewpoint-actions">
          <button
            type="button"
            disabled={!name.trim() || scenes.length >= 20}
            onClick={() => {
              const result = store.createScene(name);
              if (result.ok) onSwitch();
              report(result, `Created ${name.trim()}.`);
            }}
          >
            Add scene
          </button>
          <button
            type="button"
            disabled={!active || !name.trim()}
            onClick={() => {
              if (active) report(store.renameScene(active.id, name), "Scene renamed.");
            }}
          >
            Rename scene
          </button>
          <button
            type="button"
            disabled={!active || scenes.indexOf(active) === 0}
            onClick={() => {
              if (active) move(active.id, scenes.indexOf(active) - 1);
            }}
          >
            Move scene up
          </button>
          <button
            type="button"
            disabled={!active || scenes.indexOf(active) === scenes.length - 1}
            onClick={() => {
              if (active) move(active.id, scenes.indexOf(active) + 1);
            }}
          >
            Move scene down
          </button>
        </div>
        <button
          type="button"
          disabled={!active || scenes.length <= 1}
          onClick={() => setConfirmDelete(true)}
        >
          Delete scene
        </button>
        {scenes.length === 1 && <p>Keep at least one scene in your project.</p>}
        {confirmDelete && active && (
          <div role="group" aria-label="Confirm scene deletion">
            <p>
              Delete “{active.name}” and its {active.objects.length} objects and{" "}
              {active.viewpoints?.length ?? 0} saved views? Undo restores everything.
            </p>
            <button
              type="button"
              onClick={() => {
                const result = store.deleteScene(active.id);
                if (result.ok) {
                  setConfirmDelete(false);
                  onSwitch();
                }
                report(result, "Scene deleted. Undo restores it.");
              }}
            >
              Confirm delete scene
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        )}
        {active && (
          <label>
            Environment
            <select
              value={active.environmentAssetId ?? ""}
              onChange={(e) => {
                report(
                  store.setEnvironment(e.target.value || null),
                  "Environment updated. Undo is available.",
                );
              }}
            >
              <option value="">None (empty scene)</option>
              {assets
                .filter((a) => a.kind === "environment")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </fieldset>
      <p role="status">{message}</p>
    </section>
  );
}
