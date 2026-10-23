import { useState, type FocusEvent, type PointerEvent } from "react";
import { assetDragType, type CatalogueAsset } from "../../shared/assets/catalogue";
import type { NavigationTool } from "../graphics/scene";
import { Icon, type IconName } from "./Icon";

const cameraTools: { id: NavigationTool; label: string; hint: string; icon: IconName }[] = [
  { id: "select", label: "Select", hint: "Select · click objects to edit them", icon: "select" },
  { id: "orbit", label: "Orbit", hint: "Orbit · drag to turn the camera", icon: "orbit" },
  { id: "pan", label: "Pan", hint: "Pan · drag to slide the camera", icon: "pan" },
  { id: "zoom", label: "Zoom", hint: "Zoom · drag up or down", icon: "zoom" },
];

type Category = "furniture" | "panels" | "cases" | "audio";
type SceneTool = "library" | "hotspot" | Category;

const categories: { id: Category; label: string; icon: IconName }[] = [
  { id: "furniture", label: "Furniture", icon: "chair" },
  { id: "panels", label: "Display panels", icon: "panelStanding" },
  { id: "cases", label: "Display cases", icon: "caseClosed" },
  { id: "audio", label: "Audio", icon: "music" },
];

export function BottomBar({
  assets,
  ready,
  thumbnailFor,
  onAdd,
  onDragChange,
  tool,
  onToolChange,
}: {
  assets: readonly CatalogueAsset[];
  ready: boolean;
  thumbnailFor: (assetId: string) => string | undefined;
  onAdd: (assetId: string) => void;
  onDragChange: (dragging: boolean) => void;
  tool: NavigationTool;
  onToolChange: (tool: NavigationTool) => void;
}) {
  // Only one tool selected at a time, library start open so can add stuff straight away
  const [selected, setSelected] = useState<SceneTool | null>("library");
  const libraryOpen = selected === "library";
  const cameraTip = useTooltip();
  const toolTip = useTooltip();

  return (
    <div className="bottom-dock">
      {libraryOpen && (
        <section className="asset-panel" id="asset-panel" aria-labelledby="assets-heading">
          <h2 id="assets-heading">Asset library</h2>
          <ul className="asset-shelf" role="list">
            {assets.map((asset) => (
              <li key={asset.id}>
                <button
                  className="asset-tile"
                  type="button"
                  draggable={ready}
                  disabled={!ready}
                  aria-label={`Add ${asset.name}`}
                  title="Drag into the scene, or click to add"
                  onClick={() => onAdd(asset.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(assetDragType, asset.id);
                    event.dataTransfer.effectAllowed = "copy";
                    onDragChange(true);
                  }}
                  onDragEnd={() => onDragChange(false)}
                >
                  <span className="asset-art">
                    <img src={thumbnailFor(asset.id)} alt="" draggable={false} />
                    <span className="asset-add" aria-hidden="true">
                      +
                    </span>
                  </span>
                  <span className="asset-name">{asset.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="tool-tip-anchor">
        {cameraTip.bubble}
        <div className="mode-bar" role="group" aria-label="Camera tools">
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
        {toolTip.bubble}
        <div className="scene-toolbar" role="group" aria-label="Add to scene">
          <button
            className="ui-button"
            type="button"
            aria-label="Asset library"
            aria-pressed={libraryOpen}
            aria-controls="asset-panel"
            onClick={() => setSelected((tool) => (tool === "library" ? null : "library"))}
            {...toolTip.handlers(libraryOpen ? "Hide asset library" : "Asset library")}
          >
            <Icon name="library" />
          </button>
          <button
            className="ui-button"
            type="button"
            aria-label="Hotspot"
            aria-pressed={selected === "hotspot"}
            onClick={() => setSelected("hotspot")}
            {...toolTip.handlers("Hotspot")}
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
              onClick={() => setSelected(category.id)}
              {...toolTip.handlers(category.label)}
            >
              <Icon name={category.icon} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Bars scroll sideways on small screen, so the label is placed from the outer anchor
function useTooltip() {
  const [tip, setTip] = useState<{ label: string; x: number } | null>(null);

  function show(event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>, label: string) {
    const anchor = event.currentTarget.closest(".tool-tip-anchor")?.getBoundingClientRect();
    const button = event.currentTarget.getBoundingClientRect();
    if (anchor !== undefined) setTip({ label, x: button.left + button.width / 2 - anchor.left });
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
      <span className="tool-tip" style={{ left: tip.x }} aria-hidden="true">
        {tip.label}
      </span>
    );

  return { handlers, bubble };
}
