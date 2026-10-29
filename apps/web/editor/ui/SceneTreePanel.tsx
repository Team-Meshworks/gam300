import { useId, useState } from "react";
import type { SceneObject } from "../../shared/project/scene-object";
import { Icon } from "./Icon";

export type Room = { id: string; name: string; thumbnail: string | undefined };

// Keep tree presentation separate from transform fields while sharing the same selected object
export function SceneTreePanel({
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
  // Disclosure is local view state and must never change the project or selected object
  const [collapsed, setCollapsed] = useState(false);
  const listId = useId();
  const count = objects.length + (room === undefined ? 0 : 1);
  return (
    <section className="editor-panel" aria-labelledby="objects-heading">
      <h2 id="objects-heading">
        <Icon name="info" />
        Scene Tree <span className="panel-count">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="panel-empty">Add a room from the asset library to start.</p>
      ) : (
        <>
          <ul role="list" className={`scene-tree${expanded ? " is-expanded" : ""}`}>
            {room !== undefined && (
              <li>
                <div className="scene-root">
                  <button
                    type="button"
                    className="scene-disclosure"
                    aria-label={`${collapsed ? "Expand" : "Collapse"} scene objects`}
                    aria-expanded={!collapsed}
                    aria-controls={listId}
                    onClick={() => setCollapsed(!collapsed)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                        event.preventDefault();
                        setCollapsed(event.key === "ArrowLeft");
                      }
                    }}
                  >
                    <Icon name={collapsed ? "chevronRight" : "caretDown"} />
                  </button>
                  <button
                    className="environment-row"
                    type="button"
                    aria-pressed={selectedId === room.id}
                    onClick={() => onSelect(room.id)}
                  >
                    <img src={room.thumbnail} alt="" draggable={false} />
                    <span>{room.name}</span>
                  </button>
                </div>
                <ul className="scene-objects" id={listId} role="list" hidden={collapsed}>
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
              </li>
            )}
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
