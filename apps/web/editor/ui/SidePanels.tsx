import { useState, type ReactNode } from "react";
import type { SceneObject } from "../../shared/project/scene-object";
import type { Transform, Vector3Tuple } from "../../shared/project/project-types";
import { Icon, type IconName } from "./icon";
import { degreesToQuaternion, quaternionToDegrees } from "./rotation-angles";

type PanelId = "position" | "tree" | "interaction";
type Room = { id: string; name: string; thumbnail: string | undefined };

const railButtons: { id: PanelId; label: string; icon: IconName }[] = [
  { id: "position", label: "Position", icon: "axes" },
  { id: "tree", label: "Scene tree", icon: "tree" },
  { id: "interaction", label: "Interaction", icon: "touch" },
];

export function SidePanels({
  visitor,
  room,
  objects,
  selectedId,
  selectedObject,
  thumbnailFor,
  onSelect,
  onTransform,
}: {
  visitor: boolean;
  room: Room | undefined;
  objects: readonly SceneObject[];
  selectedId: string | null;
  selectedObject: SceneObject | undefined;
  thumbnailFor: (assetId: string) => string | undefined;
  onSelect: (id: string) => void;
  onTransform: (id: string, transform: Transform) => void;
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
              room={room}
              objects={objects}
              selectedId={selectedId}
              onSelect={onSelect}
              thumbnailFor={thumbnailFor}
            />
          )}
          {panel === "interaction" && (
            // No hotspots in the project format yet, so nothing selected is one
            <InteractionPanel hotspotName={undefined} />
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

function SceneTreePanel({
  room,
  objects,
  selectedId,
  onSelect,
  thumbnailFor,
}: {
  room: Room | undefined;
  objects: readonly SceneObject[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  thumbnailFor: (assetId: string) => string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = objects.length + (room === undefined ? 0 : 1);
  return (
    <section className="editor-panel" aria-labelledby="objects-heading">
      <PanelHeading id="objects-heading">
        Scene Tree <span className="panel-count">{count}</span>
      </PanelHeading>
      {count === 0 ? (
        <p className="panel-empty">Add a room from the asset library to start.</p>
      ) : (
        <>
          <ul role="list" className={`scene-tree${expanded ? " is-expanded" : ""}`}>
            {room !== undefined && (
              <li>
                <button
                  className="environment-row"
                  type="button"
                  aria-pressed={selectedId === room.id}
                  onClick={() => onSelect(room.id)}
                >
                  <img src={room.thumbnail} alt="" draggable={false} />
                  <span>{room.name}</span>
                </button>
              </li>
            )}
            {objects.map((object) => (
              <li key={object.id}>
                <button
                  className="object-row"
                  type="button"
                  aria-pressed={selectedId === object.id}
                  data-object-id={object.id}
                  onClick={() => onSelect(object.id)}
                >
                  <img src={thumbnailFor(object.assetId)} alt="" draggable={false} />
                  <span>{object.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {count > 6 && (
            <button
              className="ui-button panel-pill"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((previous) => !previous)}
            >
              {expanded ? "Show less" : "View all"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

const interactionSteps = [
  { label: "Do", value: "Content type" },
  { label: "Target", value: "Content" },
];

function InteractionPanel({ hotspotName }: { hotspotName: string | undefined }) {
  return (
    <section className="editor-panel" aria-labelledby="interaction-heading">
      <PanelHeading id="interaction-heading">Interaction</PanelHeading>
      {hotspotName === undefined ? (
        // Only hotspots got interactions, other objects dont show the form
        <div className="panel-placeholder">
          <span className="panel-placeholder-icon" aria-hidden="true">
            <Icon name="touch" />
          </span>
          <p>
            <strong>Select a hotspot first</strong>
          </p>
          <p className="panel-empty">
            Place a hotspot in the scene and select it to choose what happens when visitors interact
            with it.
          </p>
        </div>
      ) : (
        <>
          <div className="interaction-form" role="group" aria-label="New interaction">
            <div className="interaction-step">
              <span className="interaction-label">When</span>
              <span className="panel-select is-fixed">{hotspotName}</span>
            </div>
            {interactionSteps.map((step) => (
              <div key={step.label} className="interaction-step">
                <span className="interaction-arrow">
                  <Icon name="arrowDown" />
                </span>
                <span className="interaction-label">{step.label}</span>
                <button
                  className="ui-button panel-select"
                  type="button"
                  aria-label={`${step.label}: ${step.value} (coming soon)`}
                  aria-disabled="true"
                >
                  {step.value}
                  <Icon name="chevronRight" />
                </button>
              </div>
            ))}
            <button className="ui-button panel-pill" type="button" aria-disabled="true">
              Add
            </button>
          </div>
          <p className="panel-empty">Interactions you add will be listed here.</p>
        </>
      )}
    </section>
  );
}
