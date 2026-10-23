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

const toolGroups: { label: string; tools: { label: string; icon: IconName }[] }[] = [
  { label: "Hotspots", tools: [{ label: "Hotspot", icon: "hotspot" }] },
  {
    label: "Furniture",
    tools: [
      { label: "Rug", icon: "rug" },
      { label: "Chair", icon: "chair" },
    ],
  },
  {
    label: "Display panels",
    tools: [
      { label: "Standing panel", icon: "panelStanding" },
      { label: "Small panel", icon: "panelSmall" },
      { label: "Portrait panel", icon: "panelPortrait" },
      { label: "Landscape panel", icon: "panelLandscape" },
    ],
  },
  {
    label: "Display cases",
    tools: [
      { label: "Display case", icon: "case" },
      { label: "Closed display case", icon: "caseClosed" },
      { label: "Tall display case", icon: "caseTall" },
      { label: "Closed tall display case", icon: "caseTallClosed" },
    ],
  },
  {
    label: "Audio",
    tools: [
      { label: "Phone audio", icon: "phone" },
      { label: "Background music", icon: "music" },
      { label: "Speaker", icon: "speaker" },
    ],
  },
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
  const [libraryOpen, setLibraryOpen] = useState(true);
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
          <div className="scene-toolbar-group" role="group" aria-label="Library">
            <button
              className="ui-button"
              type="button"
              aria-label="Asset library"
              aria-pressed={libraryOpen}
              aria-controls="asset-panel"
              onClick={() => setLibraryOpen((open) => !open)}
              {...toolTip.handlers(libraryOpen ? "Hide asset library" : "Asset library")}
            >
              <Icon name="library" />
            </button>
          </div>
          {toolGroups.map((group) => (
            <div
              key={group.label}
              className="scene-toolbar-group"
              role="group"
              aria-label={group.label}
            >
              {group.tools.map((item) => (
                <button
                  key={item.label}
                  className="ui-button"
                  type="button"
                  aria-label={`${item.label} (coming soon)`}
                  aria-disabled="true"
                  {...toolTip.handlers(`${item.label} · coming soon`)}
                >
                  <Icon name={item.icon} />
                </button>
              ))}
            </div>
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
