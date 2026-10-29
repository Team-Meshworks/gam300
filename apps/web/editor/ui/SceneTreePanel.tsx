import { useId, useState } from "react";
import type { ContentObject, ProjectGroup } from "../../shared/project/project-content";
import type { SceneObject } from "../../shared/project/scene-object";
import { Icon } from "./Icon";

// One environment anchors the scene; groups describe organization rather than extra rooms
// Additional room models are ordinary placed objects within this same scene
export type Room = { id: string; name: string; thumbnail: string | undefined };

export function SceneTreePanel({
  room,
  objects,
  groups,
  selectedId,
  onSelect,
  thumbnailFor,
}: {
  room: Room | undefined;
  objects: readonly SceneObject[];
  groups: readonly ProjectGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  thumbnailFor: (assetId: string) => string | undefined;
}) {
  // Disclosure state belongs to this panel and never enters the saved project or undo stack
  // The scene ID key supplied by SidePanels resets these controls when switching projects
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const listId = useId();

  const rootId = room?.id ?? "draft";
  const count = objects.length + groups.length + (room ? 1 : 0);
  const nodes = [...groups, ...objects];

  const parentOf = (node: (typeof nodes)[number]) =>
    (node as ContentObject | ProjectGroup).parentId?.toLowerCase() ?? null;

  // Resolve parent references without changing array order or authored UUID spelling
  // Validators already ensure every parent exists and the hierarchy contains no cycles
  const children = new Map<string | null, typeof nodes>();
  for (const node of nodes) {
    // Root room instances and folders are siblings of the initial environment
    // Unparented furnishings retain their released meaning as children of that first room
    const parent =
      parentOf(node) ??
      ("assetId" in node && node.assetId !== "test-room-module-v1" ? rootId.toLowerCase() : null);
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }

  function expand(id: string, open: boolean) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function disclosure(id: string, label: string) {
    const open = !collapsed.has(id);
    return (
      <button
        className="scene-disclosure"
        type="button"
        aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
        aria-expanded={open}
        aria-controls={`${listId}-${id}`}
        onClick={() => expand(id, !open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            expand(id, event.key === "ArrowRight");
          }
        }}
      >
        <Icon name={open ? "caretDown" : "chevronRight"} />
      </button>
    );
  }

  function renderChildren(parentId: string | null) {
    const descendants = children.get(parentId?.toLowerCase() ?? null) ?? [];
    return descendants.map((node) => {
      const isObject = "assetId" in node;
      const components = isObject ? ((node as ContentObject).components ?? []) : [];
      const hasChildren = (children.get(node.id.toLowerCase())?.length ?? 0) > 0;
      // Every group has a disclosure, including empty groups ready to receive objects
      // Objects gain one when they own children, supporting imported object-to-object trees
      const expandable = !isObject || hasChildren || components.length > 0;
      return (
        <li key={node.id}>
          <div className="scene-root">
            {/* Reserve the disclosure column so adding the first child never moves its parent */}
            {expandable ? (
              disclosure(node.id, node.name)
            ) : (
              <span className="scene-disclosure-space" aria-hidden="true" />
            )}

            <button
              className={isObject ? "object-row" : "group-row"}
              type="button"
              data-object-id={isObject ? node.id : undefined}
              data-group-id={!isObject ? node.id : undefined}
              aria-pressed={selectedId === node.id}
              onClick={() => onSelect(node.id)}
            >
              {isObject ? <img src={thumbnailFor(node.assetId)} alt="" /> : <Icon name="tree" />}
              <span>{node.name}</span>
            </button>
          </div>
          {expandable && (
            <ul
              className="scene-objects"
              id={`${listId}-${node.id}`}
              role="list"
              hidden={collapsed.has(node.id)}
            >
              {hasChildren && renderChildren(node.id)}
              {/* Content retains its own identity while selection targets its owning viewport object */}
              {components.map((component) => (
                <li key={component.id}>
                  <button
                    className="group-row"
                    type="button"
                    data-component-id={component.id}
                    data-owner-id={node.id}
                    onClick={() => onSelect(node.id)}
                  >
                    <span>
                      {component.type}: {"label" in component ? component.label : component.caption}
                    </span>
                  </button>
                </li>
              ))}
              {!hasChildren && components.length === 0 && (
                <li className="panel-empty">Empty group</li>
              )}
            </ul>
          )}
        </li>
      );
    });
  }

  return (
    <section className="editor-panel" aria-labelledby="objects-heading">
      <h2 id="objects-heading">
        <Icon name="info" />
        Scene Tree <span className="panel-count">{count}</span>
      </h2>
      {!room ? (
        <p className="panel-empty">Add a room from the asset library to start.</p>
      ) : (
        <>
          <ul role="list" className={`scene-tree${showAll ? " is-expanded" : ""}`}>
            <li>
              <div className="scene-root">
                {(children.get(rootId.toLowerCase())?.length ?? 0) > 0 ? (
                  disclosure(rootId, "scene objects")
                ) : (
                  <span className="scene-disclosure-space" aria-hidden="true" />
                )}

                <button
                  className="environment-row"
                  type="button"
                  aria-pressed={selectedId === room.id}
                  data-scene-id={room.id}
                  onClick={() => onSelect(room.id)}
                >
                  <img src={room.thumbnail} alt="" />
                  <span>{room.name}</span>
                </button>
              </div>
              <ul
                className="scene-objects"
                id={`${listId}-${rootId}`}
                role="list"
                aria-label="Scene objects"
                hidden={collapsed.has(rootId)}
              >
                {nodes.length ? (
                  renderChildren(rootId)
                ) : (
                  <li className="panel-empty">No objects in this scene.</li>
                )}
              </ul>
            </li>
            {renderChildren(null)}
          </ul>
          {!collapsed.has(rootId) && count > 6 && (
            <button
              className="ui-button panel-pill"
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((previous) => !previous)}
            >
              {showAll ? "Show less" : "View all"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
