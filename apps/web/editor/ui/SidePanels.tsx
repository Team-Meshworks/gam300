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
import type { ProjectGroup } from "../../shared/project/project-content";

type PanelId = "scenes" | "position" | "tree" | "interaction" | "views";

const railButtons: { id: PanelId; label: string; icon: IconName }[] = [
  { id: "position", label: "Position", icon: "axes" },
  { id: "tree", label: "Scene tree", icon: "tree" },
  { id: "scenes", label: "Scenes", icon: "library" },
  { id: "views", label: "Saved views", icon: "tree" },
  { id: "interaction", label: "Interaction", icon: "touch" },
];

export function SidePanels({
  visitor,
  savedViews,
  scenes,
  room,
  objects,
  selectedId,
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
}: {
  groups: readonly ProjectGroup[];
  hierarchy: HierarchyActions;
  visitor: boolean;
  savedViews: ReactNode;
  scenes: ReactNode;
  room: Room | undefined;
  objects: readonly SceneObject[];
  selectedId: string | null;
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
              onChange={(transform) => {
                if (selectedObject !== undefined) onTransform(selectedObject.id, transform);
              }}
            />
          )}
          {panel === "tree" && (
            <SceneTreePanel
              key={room?.id ?? "draft"}
              room={room}
              groups={groups}
              hierarchy={hierarchy}
              objects={objects}
              hotspots={hotspots}
              selectedId={selectedId}
              onSelect={onSelect}
              onDelete={onDelete}
              mobileDevice={mobileDevice}
              thumbnailFor={thumbnailFor}
            />
          )}
          {panel === "scenes" && <div className="editor-panel">{scenes}</div>}
          {panel === "views" && <div className="editor-panel">{savedViews}</div>}
          {panel === "interaction" && (
            <InteractionPanel
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

      <button
        className="ui-button filter-button"
        type="button"
        aria-disabled="true"
        title="Filters · coming soon"
      >
        Filters
        <Icon name="caretDown" />
      </button>

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
}: {
  object: SceneObject | undefined;
  onChange: (transform: Transform) => void;
}) {
  return (
    <section className="editor-panel" aria-labelledby="position-heading">
      <PanelHeading id="position-heading">Position</PanelHeading>
      {object === undefined ? (
        <p className="panel-empty">Select an object to edit its position, rotation and scale.</p>
      ) : (
        <TransformFields object={object} onChange={onChange} />
      )}
    </section>
  );
}

function TransformFields({
  object,
  onChange,
}: {
  object: SceneObject;
  onChange: (transform: Transform) => void;
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
      {rows.map((row) => (
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
