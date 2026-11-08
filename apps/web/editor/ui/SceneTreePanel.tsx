import { isRoomModel, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { displayPanelTools, displayCaseTools } from "./display-tools";
import { useId, useRef, useState, type DragEvent } from "react";
import type { ContentObject, ProjectGroup } from "../../shared/project/project-content";
import type { SceneObject } from "../../shared/project/scene-object";
import { Icon } from "./Icon";

// One environment anchors the scene; groups describe organization rather than extra rooms
// Additional room models are ordinary placed objects within this same scene
export type Room = { id: string; name: string; thumbnail: string | undefined };
export type HierarchyActions = {
  rename: (id: string, name: string) => boolean;
  move: (id: string, parentId: string | null) => void;
};

export function SceneTreePanel({
  assets = [],
  room,
  objects,
  groups,
  hotspots,
  selectedId,
  selectedIds = selectedId === null ? [] : [selectedId],
  onMultiSelect,
  onSelect,
  onDelete,
  mobileDevice,
  thumbnailFor,
  hierarchy,
  sceneAudio = [],
}: {
  assets?: readonly CatalogueAsset[];
  sceneAudio?: readonly Extract<
    import("../../shared/project/project-content").ContentComponent,
    { type: "audio" }
  >[];
  room: Room | undefined;
  objects: readonly SceneObject[];
  groups: readonly ProjectGroup[];
  hotspots: readonly import("../../shared/project/project-types").ProjectHotspot[];
  selectedId: string | null;
  selectedIds?: readonly string[] | undefined;
  onMultiSelect?: ((ids: readonly string[], id: string | null) => void) | undefined;
  onSelect: (id: string) => void;
  onDelete: () => void;
  // Touch has no Delete key, so the selected object gets its own button
  mobileDevice: boolean;
  thumbnailFor: (assetId: string) => string | undefined;
  hierarchy: HierarchyActions;
}) {
  // Disclosure state belongs to this panel and never enters the saved project or undo stack
  // The scene ID key supplied by SidePanels resets these controls when switching projects
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const moving = useRef<string | null>(null);
  // The draft name stays in the input until a confirmed store command succeeds
  const [renaming, setRenaming] = useState<string | null>(null);
  const listId = useId();
  const panel = useRef<HTMLElement>(null);
  const rangeAnchor = useRef<string | null>(null);
  // Shift follows visible tree order; Ctrl toggles membership without changing authored parentage
  function selectRow(id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    if (!onMultiSelect) return onSelect(id);
    const toggle = event.ctrlKey || event.metaKey;
    let next: readonly string[] = [id];
    if (event.shiftKey && rangeAnchor.current) {
      const order = [
        ...(panel.current?.querySelectorAll<HTMLButtonElement>(
          "button[data-object-id], button[data-scene-id], button[data-group-id]",
        ) ?? []),
      ].map((row) => row.dataset.objectId ?? row.dataset.sceneId ?? row.dataset.groupId!);
      const start = order.indexOf(rangeAnchor.current),
        end = order.indexOf(id);
      if (start >= 0 && end >= 0)
        next = order.slice(Math.min(start, end), Math.max(start, end) + 1);
      if (toggle) next = [...new Set([...selectedIds, ...next])];
    } else {
      rangeAnchor.current = id;
      if (toggle)
        next = selectedIds.includes(id)
          ? selectedIds.filter((entry) => entry !== id)
          : [...selectedIds, id];
    }
    onMultiSelect(next, next.includes(id) ? id : (next.at(-1) ?? null));
  }
  const dragging = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const rootId = room?.id ?? "draft";
  const count = objects.length + groups.length + (room ? 1 : 0);
  // Older drafts retain the released generated names; show the current labels without rewriting their data
  const roomName = room?.name === "test-room" ? "Starter room" : (room?.name ?? "");
  const nodes = [
    ...groups,
    ...objects.map((object, index) => {
      const label =
        assets.find((asset) => asset.id === object.assetId)?.name ??
        (object.assetId === "test-crate-v1"
          ? "Sample crate"
          : object.assetId === "test-room-module-v1"
            ? "Starter room"
            : null);
      const legacy =
        object.assetId === "test-crate-v1"
          ? /^test-crate( \d+)?$/.test(object.name)
          : object.assetId === "test-room-module-v1" && /^test-room( \d+)?$/.test(object.name);
      if (!label || (!legacy && object.name !== `${label} 1`)) return object;
      const number =
        objects.slice(0, index).filter((entry) => entry.assetId === object.assetId).length +
        1 +
        (room && isRoomModel(assets, object.assetId) ? 1 : 0);
      return { ...object, name: number === 1 ? label : `${label} ${number}` };
    }),
  ];

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
      // Furnishings stay at the visible tree root when the initial room no longer exists
      (room && "assetId" in node && !isRoomModel(assets, node.assetId)
        ? rootId.toLowerCase()
        : null);
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

  function drop(event: DragEvent, parentId: string | null) {
    event.preventDefault();
    event.stopPropagation();
    // Accept only drags begun by this tree, never external text or asset-library payloads
    // The store performs the final cycle and reference validation before touching history
    const id = dragging.current;
    dragging.current = null;
    setDropTarget(null);
    setDraggedId(null);
    if (id && event.dataTransfer.getData("application/x-spatia-hierarchy") === id) {
      hierarchy.move(id, parentId);
    }
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

  // Overlay the existing row so editing cannot change its measured width or scroll position
  function renameField(id: string, name: string) {
    return renaming === id ? (
      <input
        className="tree-rename"
        aria-label={`Rename ${name}`}
        defaultValue={name}
        size={Math.max(4, Math.min(18, name.length + 1))}
        onInput={(event) => {
          event.currentTarget.size = Math.max(
            4,
            Math.min(18, event.currentTarget.value.length + 1),
          );
        }}
        maxLength={120}
        ref={(input) => {
          // Native autofocus scrolls the whole tree to reveal the field's right edge
          if (input) {
            input.focus({ preventScroll: true });
            input.select();
          }
        }}
        // Leaving the field cancels the draft without changing the selected object
        onBlur={() => setRenaming(null)}
        onKeyDown={(event) => {
          // Keep draft text outside project state until Enter validates one rename command
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            setRenaming(null);
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (hierarchy.rename(id, event.currentTarget.value)) setRenaming(null);
          }
        }}
      />
    ) : null;
  }

  function renderChildren(parentId: string | null) {
    const descendants = children.get(parentId?.toLowerCase() ?? null) ?? [];
    return descendants.map((node) => {
      const isObject = "assetId" in node;
      const displayTool = isObject
        ? [...displayPanelTools, ...displayCaseTools].find((tool) => tool.assetId === node.assetId)
        : undefined;
      const components = isObject ? ((node as ContentObject).components ?? []) : [];
      const hasChildren = (children.get(node.id.toLowerCase())?.length ?? 0) > 0;
      // Every group has a disclosure, including empty groups ready to receive objects
      // Objects gain one when they own children, supporting imported object-to-object trees
      const expandable = !isObject || hasChildren || components.length > 0;
      return (
        <li key={node.id}>
          <div
            className="scene-root"
            data-drop-target={dropTarget === node.id || undefined}
            data-dragging={draggedId === node.id || undefined}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDropTarget(null);
            }}
            onDragOver={(event) => {
              if (dragging.current) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                setDropTarget(dragging.current === node.id ? null : node.id);
              }
            }}
            onDrop={(event) => drop(event, node.id)}
          >
            {/* Reserve the disclosure column so adding the first child never moves its parent */}
            {expandable ? (
              disclosure(node.id, node.name)
            ) : (
              <span className="scene-disclosure-space" aria-hidden="true" />
            )}
            {renameField(node.id, node.name)}
            <button
              style={{ visibility: renaming === node.id ? "hidden" : undefined }}
              className={isObject ? "object-row" : "group-row"}
              type="button"
              data-object-id={isObject ? node.id : undefined}
              data-group-id={!isObject ? node.id : undefined}
              aria-pressed={selectedIds.includes(node.id)}
              draggable
              title="Drag to reparent, or use Ctrl+X then Ctrl+V on the destination"
              // Object rows can enter the same rename flow by mouse or keyboard
              onDoubleClick={() => {
                if (isObject) setRenaming(node.id);
              }}
              onDragStart={(event) => {
                // Selection remains unchanged while moving a row between parents
                dragging.current = node.id;
                setDraggedId(node.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-spatia-hierarchy", node.id);
              }}
              onDragEnd={() => {
                dragging.current = null;
                setDraggedId(null);
                setDropTarget(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "F2" && isObject) {
                  event.preventDefault();
                  setRenaming(node.id);
                  return;
                }
                // Keyboard reparenting shares validation with drag and drop
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
                  event.preventDefault();
                  event.stopPropagation();
                  moving.current = node.id;
                }
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === "v" &&
                  moving.current
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  hierarchy.move(moving.current, node.id);
                  moving.current = null;
                }
              }}
              onClick={(event) => selectRow(node.id, event)}
            >
              {isObject ? (
                displayTool ? (
                  <Icon name={displayTool.icon} />
                ) : (
                  <img src={thumbnailFor(node.assetId)} alt="" draggable={false} />
                )
              ) : (
                <Icon name="tree" />
              )}
              <span>{node.name}</span>
              {hotspots.some(
                (hotspot) => hotspot.objectId.toLowerCase() === node.id.toLowerCase(),
              ) && (
                <span className="hotspot-indicator" title="Has hotspot">
                  <Icon name="hotspot" />
                  <span className="sr-only">Has hotspot</span>
                </span>
              )}
            </button>
            {mobileDevice && isObject && selectedId === node.id && (
              <button
                className="scene-tree-delete"
                type="button"
                aria-label={`Delete ${node.name}`}
                title={`Delete ${node.name}`}
                onClick={onDelete}
              >
                ×
              </button>
            )}
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
                    aria-pressed={component.type === "audio" && selectedId === component.id}
                    data-component-id={component.id}
                    data-owner-id={node.id}
                    onKeyDown={(event) => {
                      // Keyboard reparenting shares validation with drag and drop
                      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
                        event.preventDefault();
                        event.stopPropagation();
                        moving.current = node.id;
                      }
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key.toLowerCase() === "v" &&
                        moving.current
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        hierarchy.move(moving.current, node.id);
                        moving.current = null;
                      }
                    }}
                    onClick={() => {
                      onSelect(component.type === "audio" ? component.id : node.id);
                    }}
                  >
                    <Icon
                      name={
                        component.type === "audio"
                          ? "music"
                          : component.type === "video"
                            ? "video"
                            : component.type === "image"
                              ? "image"
                              : component.type === "text"
                                ? "text"
                                : "info"
                      }
                    />
                    <span>
                      {component.type === "text"
                        ? component.runs.map((run) => run.text).join("") || "Text"
                        : "assetId" in component
                          ? (assets.find((asset) => asset.id === component.assetId)?.name ??
                            `${component.type[0]!.toUpperCase()}${component.type.slice(1)}`)
                          : "label" in component
                            ? component.label
                            : "Content"}
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
    <section ref={panel} className="editor-panel" aria-labelledby="objects-heading">
      <h2 id="objects-heading">
        <Icon name="info" title="Select objects or drag them to change their nesting" />
        Scene Tree <span className="panel-count">{count}</span>
      </h2>
      {!room && objects.length === 0 && groups.length === 0 ? (
        <p className="panel-empty">Add a room to start.</p>
      ) : (
        <>
          <ul role="list" className={`scene-tree${showAll ? " is-expanded" : ""}`}>
            {room && (
              <li>
                <div
                  className="scene-root"
                  data-drop-target={dropTarget === rootId || undefined}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      setDropTarget(null);
                  }}
                  onDragOver={(event) => {
                    if (dragging.current) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTarget(rootId);
                    }
                  }}
                  onDrop={(event) => drop(event, null)}
                >
                  {(children.get(rootId.toLowerCase())?.length ?? 0) > 0 ? (
                    disclosure(rootId, "scene objects")
                  ) : (
                    <span className="scene-disclosure-space" aria-hidden="true" />
                  )}
                  {/* The environment row uses its scene ID for the same rename command */}
                  {renameField(room.id, roomName)}
                  <button
                    style={{ visibility: renaming === room.id ? "hidden" : undefined }}
                    onDoubleClick={() => setRenaming(room.id)}
                    className="environment-row"
                    type="button"
                    aria-pressed={selectedIds.includes(room.id)}
                    data-scene-id={room.id}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        setRenaming(room.id);
                        return;
                      }
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key.toLowerCase() === "v" &&
                        moving.current
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        hierarchy.move(moving.current, null);
                        moving.current = null;
                      }
                    }}
                    onClick={(event) => selectRow(room.id, event)}
                  >
                    <img src={room.thumbnail} alt="" draggable={false} />
                    <span>{roomName}</span>
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
                    <li className="panel-empty scene-tree-empty">No objects in this scene.</li>
                  )}
                </ul>
              </li>
            )}
            {renderChildren(null)}
            {sceneAudio.map((audio) => (
              <li key={audio.id} className="scene-audio-row">
                <button
                  className="ui-button scene-audio-select"
                  type="button"
                  aria-pressed={selectedId === audio.id}
                  onClick={() => onSelect(audio.id)}
                >
                  <Icon name="music" />
                  <span>{assets.find((asset) => asset.id === audio.assetId)?.name ?? "Audio"}</span>
                </button>
              </li>
            ))}
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
