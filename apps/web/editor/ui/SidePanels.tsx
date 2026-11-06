import { isStarterRoomModel, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { useState, type ReactNode } from "react";
import type { SceneObject } from "../../shared/project/scene-object";
import type {
  ProjectHotspot,
  ProjectScene,
  Transform,
  Vector3Tuple,
} from "../../shared/project/project-types";
import { Icon, type IconName } from "./Icon";
import type { Interaction } from "../interaction/interactionHandler";
import { InteractionPanel } from "./InteractionPanel";
import { degreesToQuaternion, quaternionToDegrees } from "./rotation-angles";

import { SceneTreePanel, type Room, type HierarchyActions } from "./SceneTreePanel";
import type { ContentObject, ProjectGroup } from "../../shared/project/project-content";

type PanelId = "scenes" | "position" | "tree" | "interaction" | "views";

const railButtons: { id: PanelId; label: string; icon: IconName }[] = [
  { id: "position", label: "Position", icon: "axes" },
  { id: "tree", label: "Scene tree", icon: "tree" },
  { id: "scenes", label: "Scenes", icon: "scenes" },
  { id: "views", label: "Saved views", icon: "savedView" },
  { id: "interaction", label: "Interaction", icon: "touch" },
];

export function SidePanels({
  assets = [],
  visitor,
  savedViews,
  scenes,
  room,
  objects,
  selectedId,
  selectedIds,
  onMultiSelect,
  selectedObject,
  mobileDevice,
  hotspots,
  interactions,
  projectScenes,
  activeSceneId,
  thumbnailFor,
  onSelect,
  onDelete,
  onTransform,
  onInteractionsChange,
  onLocate,
  groups,
  hierarchy,
  sceneAudio = [],
  onHotspotRemove,
}: {
  assets?: readonly CatalogueAsset[];
  sceneAudio?: readonly Extract<
    import("../../shared/project/project-content").ContentComponent,
    { type: "audio" }
  >[];
  onHotspotRemove?: ((id: string) => void) | undefined;
  groups: readonly ProjectGroup[];
  hierarchy: HierarchyActions;
  visitor: boolean;
  savedViews: ReactNode;
  scenes: ReactNode;
  room: Room | undefined;
  objects: readonly SceneObject[];
  selectedId: string | null;
  selectedIds?: readonly string[];
  onMultiSelect?: (ids: readonly string[], id: string | null) => void;
  selectedObject: SceneObject | undefined;
  mobileDevice: boolean;
  hotspots: readonly ProjectHotspot[];
  interactions: readonly Interaction[];
  projectScenes: readonly ProjectScene[];
  activeSceneId: string | null;
  thumbnailFor: (assetId: string) => string | undefined;
  onSelect: (id: string) => void;
  onDelete: () => void;
  onTransform: (id: string, transform: Transform) => void;
  onLocate: (id: string) => void;
  onInteractionsChange: (next: Interaction[]) => void;
}) {
  // Open the tree first so new project can see whats inside
  const [panel, setPanel] = useState<PanelId | null>("tree");

  return (
    <aside className="library" aria-label="Editor panels" inert={visitor}>
      <nav className="panel-rail" aria-label="Panels">
        {railButtons.map((button) => (
          <button
            key={button.id}
            className="ui-button rail-button"
            type="button"
            data-panel={button.id}
            aria-label={button.label}
            title={button.label}
            aria-pressed={panel === button.id}
            onClick={() => setPanel((open) => (open === button.id ? null : button.id))}
          >
            <Icon name={button.icon} />
          </button>
        ))}
      </nav>

      {panel !== null && (
        <div className={`panel-slot is-${panel}`}>
          {panel === "position" && (
            <PositionPanel
              object={selectedObject}
              room={
                selectedObject?.id === room?.id ||
                isStarterRoomModel(assets, selectedObject?.assetId)
              }
              onChange={(transform) => {
                if (selectedObject !== undefined) onTransform(selectedObject.id, transform);
              }}
            />
          )}
          {panel === "tree" && (
            <SceneTreePanel
              key={room?.id ?? "draft"}
              assets={assets}
              sceneAudio={sceneAudio}
              room={room}
              groups={groups}
              hierarchy={hierarchy}
              objects={objects}
              hotspots={hotspots}
              selectedId={selectedId}
              selectedIds={selectedIds}
              onMultiSelect={onMultiSelect}
              onSelect={onSelect}
              onDelete={onDelete}
              mobileDevice={mobileDevice}
              thumbnailFor={thumbnailFor}
            />
          )}
          {panel === "scenes" && <div className="editor-panel">{scenes}</div>}
          {panel === "views" && (
            <section className="editor-panel" aria-labelledby="saved-views-heading">
              <h2 id="saved-views-heading">Saved Views</h2>
              {savedViews}
            </section>
          )}
          {panel === "interaction" && (
            <InteractionPanel
              selectedObjectId={selectedObject?.id}
              onHotspotRemove={onHotspotRemove}
              audioTargets={[
                ...sceneAudio,
                ...objects.flatMap((object) => (object as Partial<ContentObject>).components ?? []),
              ]
                .filter((entry) => entry.type === "audio")
                .map((entry) => ({
                  value: entry.id,
                  label: assets.find((asset) => asset.id === entry.assetId)?.name ?? "Audio",
                }))}
              interactions={interactions}
              scenes={projectScenes}
              activeSceneId={activeSceneId}
              hotspots={hotspots}
              objects={objects}
              onChange={onInteractionsChange}
              onLocate={onLocate}
            />
          )}
        </div>
      )}

      {selectedObject !== undefined && (
        // Browser checks read this without opening the panel
        <output className="sr-only" aria-label="Selected position">
          {selectedObject.transform.position
            .map((value, axis) => `${"XYZ"[axis]} ${value.toFixed(2)}`)
            .join(" · ")}{" "}
          m
        </output>
      )}
    </aside>
  );
}

function PanelHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id}>
      <Icon name="info" />
      {children}
    </h2>
  );
}

function PositionPanel({
  object,
  onChange,
  room,
}: {
  object: SceneObject | undefined;
  onChange: (transform: Transform) => void;
  room: boolean;
}) {
  return (
    <section className="editor-panel" aria-labelledby="position-heading">
      <PanelHeading id="position-heading">Position</PanelHeading>
      {object === undefined ? (
        <p className="panel-empty">Select an object to edit its position, rotation and scale.</p>
      ) : (
        <TransformFields object={object} onChange={onChange} room={room} />
      )}
    </section>
  );
}

function TransformFields({
  object,
  onChange,
  room,
}: {
  object: SceneObject;
  onChange: (transform: Transform) => void;
  room: boolean;
}) {
  const { transform } = object;
  const rows: {
    label: string;
    icon: IconName;
    unit: string;
    values: Vector3Tuple;
    apply: (values: Vector3Tuple) => Transform;
  }[] = [
    {
      label: "Transform",
      icon: "move",
      unit: "m",
      values: transform.position,
      apply: (position) => ({ ...transform, position }),
    },
    {
      label: "Rotation",
      icon: "rotate",
      unit: "°",
      values: quaternionToDegrees(transform.rotation),
      apply: (degrees) => ({ ...transform, rotation: degreesToQuaternion(degrees) }),
    },
    {
      label: "Scale",
      icon: "scale",
      unit: "×",
      values: transform.scale,
      apply: (scale) => ({ ...transform, scale }),
    },
  ];

  return (
    <div className="transform-fields">
      {rows
        .filter((row) => row.label !== "Scale" || !room)
        .map((row) => (
          <fieldset key={row.label}>
            <legend>
              <Icon name={row.icon} />
              {row.label}
            </legend>
            <div className="axis-fields">
              {(["X", "Y", "Z"] as const).map((axisName, axis) => (
                <label key={axisName}>
                  <span>{axisName}</span>
                  <NumberField
                    label={`${object.name} ${row.label.toLowerCase()} ${axisName} (${row.unit})`}
                    value={row.values[axis] ?? 0}
                    onCommit={(value) => {
                      const next: [number, number, number] = [...row.values];
                      next[axis] = value;
                      onChange(row.apply(next));
                    }}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
    </div>
  );
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const shown = Number(value.toFixed(2)).toString();
  return (
    // New key when the value change, so undo or gizmo drag will refresh the box
    <input
      key={shown}
      type="text"
      inputMode="decimal"
      aria-label={label}
      defaultValue={shown}
      onBlur={(event) => {
        const next = Number(event.currentTarget.value);
        if (event.currentTarget.value.trim() === "" || !Number.isFinite(next)) {
          event.currentTarget.value = shown;
        } else if (next !== Number(shown)) {
          onCommit(next);
          // Rejected or unchanged edits keep the authored value; accepted edits remount with their result
          event.currentTarget.value = shown;
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = shown;
          event.currentTarget.blur();
        }
      }}
    />
  );
}
