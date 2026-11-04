import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { assetDragType, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { playUiSound } from "../audio/ui-sounds";
import type { NavigationTool } from "../graphics/scene";
import { AssetPicker } from "./AssetPicker";
import { dockEdges, loadDockEdge, nearestEdge, saveDockEdge, type DockEdge } from "./dock-edge";
import { Icon, type IconName } from "./Icon";
import { displayPanelTools, displayCaseTools } from "./display-tools";

const cameraTools: { id: NavigationTool; label: string; hint: string; icon: IconName }[] = [
  { id: "select", label: "Select", hint: "Select · click objects to edit them", icon: "select" },
  { id: "orbit", label: "Orbit", hint: "Orbit · drag to turn the camera", icon: "orbit" },
  { id: "pan", label: "Pan", hint: "Pan · drag to slide the camera", icon: "pan" },
  { id: "zoom", label: "Zoom", hint: "Zoom · drag up or down", icon: "zoom" },
];

type Category = "furniture" | "panels" | "cases" | "audio";
type SceneTool = "library" | Category;
type Item = { label: string; icon: IconName; assetId?: string };
type PopupId = Category | "dock";

const edgeLabels: Record<DockEdge, string> = {
  bottom: "Bottom",
  top: "Top",
  left: "Left",
  right: "Right",
};

// CSS pick x or y depending on which side the bar is docked
function place(point: { x: number; y: number }, name: "popup" | "tip") {
  return { [`--${name}-x`]: `${point.x}px`, [`--${name}-y`]: `${point.y}px` } as CSSProperties;
}

// First item is what the bar show until something else is picked
const categories: { id: Category; label: string; items: [Item, ...Item[]] }[] = [
  { id: "furniture", label: "Furniture", items: [{ label: "Chair", icon: "chair" }] },
  { id: "panels", label: "Display panels", items: displayPanelTools },
  { id: "cases", label: "Display cases", items: displayCaseTools },
  { id: "audio", label: "Audio", items: [{ label: "Background music", icon: "music" }] },
];

export function BottomBar({
  assets,
  hotspot,
  ready,
  thumbnailFor,
  onAdd,
  onDragChange,
  tool,
  onToolChange,
  selectedDisplay,
}: {
  assets: readonly CatalogueAsset[];
  hotspot: CatalogueAsset;
  ready: boolean;
  thumbnailFor: (assetId: string) => string | undefined;
  onAdd: (assetId: string) => void;
  onDragChange: (dragging: boolean) => void;
  tool: NavigationTool;
  onToolChange: (tool: NavigationTool) => void;
  selectedDisplay?: { name: string; onEdit: () => void; disabled: boolean } | undefined;
}) {
  // Only one tool selected at a time. Library start closed now since its a big pop up
  const [selected, setSelected] = useState<SceneTool | null>(null);
  const libraryOpen = selected === "library";
  const [picked, setPicked] = useState<Record<Category, number>>({
    furniture: 0,
    panels: 0,
    cases: 0,
    audio: 0,
  });
  const [popup, setPopup] = useState<{ id: PopupId; x: number; y: number } | null>(null);
  const [edge, setEdge] = useState<DockEdge>(loadDockEdge);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const dock = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const gripButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const cameraTip = useTooltip();
  const toolTip = useTooltip();
  const popupTip = useTooltip();

  useEffect(() => {
    if (popup === null) return;
    // Click anywhere outside the bar or press Esc to close the pop up
    function closeOutside(event: globalThis.PointerEvent) {
      if (event.target instanceof Node && !dock.current?.contains(event.target)) setPopup(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPopup(null);
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [popup]);

  useEffect(() => {
    if (!libraryOpen) return;
    // Keep background controls inactive without blocking the existing drag-and-drop placement path
    function blockOutside(event: Event) {
      const inside = [picker.current, dock.current].some(
        (element) => event.target instanceof Node && element?.contains(event.target),
      );
      if (!inside) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setSelected(null);
    }
    document.addEventListener("pointerdown", blockOutside, true);
    document.addEventListener("click", blockOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", blockOutside, true);
      document.removeEventListener("click", blockOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [libraryOpen]);

  function select(tool: SceneTool | null) {
    setSelected(tool);
    setPopup(null);
  }

  // Remember where the button is so the pop up can open right beside it
  function openPopup(button: HTMLElement, id: PopupId) {
    const anchor = button.closest(".tool-tip-anchor")?.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    if (anchor !== undefined) setPopup({ id, x: box.left - anchor.left, y: box.top - anchor.top });
  }

  // Display tools open their concrete choices immediately; selecting one uses normal placement.
  function chooseCategory(event: MouseEvent<HTMLButtonElement>, id: Category) {
    if (popup?.id === id) return setPopup(null);
    setSelected(id);
    openPopup(event.currentTarget, id);
  }

  function dockTo(next: DockEdge) {
    setEdge(next);
    saveDockEdge(next);
    setPopup(null);
  }

  // Drag the grip to move the bar, a plain click or Enter open the dock menu instead
  const gripHandlers = {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, moved: false };
      justDragged.current = false;
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const start = drag.current;
      if (start === null) return;
      const x = event.clientX - start.x;
      const y = event.clientY - start.y;
      // Small wobble while clicking shouldnt count as a drag
      if (!start.moved && Math.hypot(x, y) < 4) return;
      start.moved = true;
      setPopup(null);
      setDragOffset({ x, y });
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const start = drag.current;
      drag.current = null;
      setDragOffset(null);
      if (start?.moved !== true) return;
      justDragged.current = true;
      const area = dock.current?.offsetParent?.getBoundingClientRect();
      if (area === undefined) return;
      dockTo(
        nearestEdge(event.clientX - area.left, event.clientY - area.top, area.width, area.height),
      );
    },
    onLostPointerCapture() {
      drag.current = null;
      setDragOffset(null);
    },
    onClick(event: MouseEvent<HTMLButtonElement>) {
      // Browser still fire a click after the drag, ignore that one
      if (justDragged.current) {
        justDragged.current = false;
        return;
      }
      if (popup?.id === "dock") return setPopup(null);
      openPopup(event.currentTarget, "dock");
    },
  };

  const open = categories.find((category) => category.id === popup?.id);

  return (
    <>
      {libraryOpen && (
        // Outside the dock so it can be big and centred in the scene, not squeezed into the bar
        <div className="asset-picker-layer" ref={picker}>
          <AssetPicker
            assets={assets.filter((asset) => asset.id !== "test-room-module-v1")}
            ready={ready}
            thumbnailFor={thumbnailFor}
            onAdd={onAdd}
            onDragChange={onDragChange}
            onClose={() => select(null)}
          />
        </div>
      )}
      <div
        className={`bottom-dock${dragOffset === null ? "" : " is-moving"}`}
        ref={dock}
        data-edge={edge}
        style={
          dragOffset === null ? undefined : { translate: `${dragOffset.x}px ${dragOffset.y}px` }
        }
      >
        {selectedDisplay && !libraryOpen && (
          <button
            type="button"
            className="display-content-launcher"
            disabled={selectedDisplay.disabled}
            title={`Edit ${selectedDisplay.name}`}
            onClick={selectedDisplay.onEdit}
          >
            Edit display content
          </button>
        )}
        <div className="tool-tip-anchor">
          {cameraTip.bubble}
          <div className="mode-bar" role="group" aria-label="Camera tools" inert={libraryOpen}>
            {cameraTools.map((cameraTool) => (
              <button
                key={cameraTool.id}
                className="ui-button"
                type="button"
                aria-label={cameraTool.label}
                aria-pressed={cameraTool.id === tool}
                onClick={() => onToolChange(cameraTool.id)}
                {...cameraTip.handlers(cameraTool.hint)}
              >
                <Icon name={cameraTool.icon} />
              </button>
            ))}
          </div>
        </div>

        <div className="tool-tip-anchor">
          {popup === null && toolTip.bubble}
          {popup !== null && (
            // Outside the toolbar so its scroll wont cut the pop up off
            <div className="tool-popup-anchor" style={place(popup, "popup")}>
              <div className="tool-tip-anchor">
                {popupTip.bubble}
                {open === undefined ? (
                  <div className="dock-menu" role="group" aria-label="Dock toolbar">
                    {dockEdges.map((option) => (
                      <button
                        key={option}
                        className="ui-button"
                        type="button"
                        aria-pressed={edge === option}
                        onClick={() => {
                          dockTo(option);
                          gripButton.current?.focus();
                        }}
                      >
                        {edgeLabels[option]}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="tool-popup" role="group" aria-label={`${open.label} options`}>
                    {open.items.map((item, index) => (
                      <button
                        key={item.label}
                        className="ui-button"
                        type="button"
                        aria-label={item.label}
                        aria-pressed={picked[open.id] === index}
                        disabled={
                          item.assetId !== undefined &&
                          (!ready || !assets.some((asset) => asset.id === item.assetId))
                        }
                        draggable={
                          item.assetId !== undefined &&
                          ready &&
                          assets.some((asset) => asset.id === item.assetId)
                        }
                        onDragStart={(event) => {
                          if (!item.assetId) return;
                          event.dataTransfer.setData(assetDragType, item.assetId);
                          event.dataTransfer.effectAllowed = "copy";
                          onDragChange(true);
                        }}
                        onDragEnd={() => {
                          onDragChange(false);
                          setPopup(null);
                        }}
                        onClick={() => {
                          setPicked((previous) => ({ ...previous, [open.id]: index }));
                          setPopup(null);
                          playUiSound("assetSelect");
                          if (item.assetId) onAdd(item.assetId);
                        }}
                        {...popupTip.handlers(item.label)}
                      >
                        <Icon name={item.icon} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="scene-toolbar" role="group" aria-label="Add to scene">
            <button
              ref={gripButton}
              className="ui-button dock-grip"
              type="button"
              aria-label="Move toolbar"
              aria-expanded={popup?.id === "dock"}
              {...gripHandlers}
              {...toolTip.handlers("Drag to move · click to pick a side")}
            >
              <Icon name="grip" />
            </button>
            <button
              className="ui-button"
              type="button"
              aria-label="Asset library"
              aria-pressed={libraryOpen}
              aria-controls="asset-panel"
              onClick={() => select(libraryOpen ? null : "library")}
              {...toolTip.handlers(libraryOpen ? "Hide asset library" : "Asset library")}
            >
              <Icon name="library" />
            </button>
            <button
              className="ui-button"
              type="button"
              draggable={ready && !libraryOpen}
              disabled={!ready || libraryOpen}
              aria-label={`Add ${hotspot.name}`}
              title="Drag into the scene, or click to add"
              onClick={() => onAdd(hotspot.id)}
              onDragStart={(event) => {
                event.dataTransfer.setData(assetDragType, hotspot.id);
                event.dataTransfer.effectAllowed = "copy";
                onDragChange(true);
              }}
              onDragEnd={() => onDragChange(false)}
              {...toolTip.handlers(hotspot.name)}
            >
              <Icon name="hotspot" />
            </button>
            <span className="toolbar-divider" aria-hidden="true" />
            {categories.map((category) => (
              <button
                key={category.id}
                className="ui-button"
                type="button"
                aria-label={category.label}
                aria-pressed={selected === category.id}
                aria-expanded={popup?.id === category.id}
                onClick={(event) => chooseCategory(event, category.id)}
                {...toolTip.handlers(category.label)}
              >
                <Icon name={(category.items[picked[category.id]] ?? category.items[0]).icon} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// Bars can scroll, so the label is placed from the outer anchor instead
function useTooltip() {
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);

  function show(event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>, label: string) {
    const anchor = event.currentTarget.closest(".tool-tip-anchor")?.getBoundingClientRect();
    const button = event.currentTarget.getBoundingClientRect();
    if (anchor === undefined) return;
    setTip({
      label,
      x: button.left + button.width / 2 - anchor.left,
      y: button.top + button.height / 2 - anchor.top,
    });
  }

  function hide() {
    setTip(null);
  }

  function handlers(label: string) {
    return {
      onPointerEnter: (event: PointerEvent<HTMLElement>) => show(event, label),
      onPointerLeave: hide,
      onFocus: (event: FocusEvent<HTMLElement>) => show(event, label),
      onBlur: hide,
    };
  }

  const bubble =
    tip === null ? null : (
      <span className="tool-tip" style={place(tip, "tip")} aria-hidden="true">
        {tip.label}
      </span>
    );

  return { handlers, bubble };
}
