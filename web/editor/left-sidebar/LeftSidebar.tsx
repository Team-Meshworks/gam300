import { useState, type DragEvent } from "react";
import type { CatalogueAsset } from "../../shared/assets/catalogue";
import type { SceneObject, Vector3Tuple } from "../../shared/project/scene-object";
import type { ViewportStatus } from "../graphics/scene";

type LeftSidebarProps = {
  assets: readonly CatalogueAsset[];
  objects: readonly SceneObject[];
  hasProject: boolean;
  selectedId: string | null;
  selectedObject: SceneObject | undefined;
  status: ViewportStatus;
  thumbnailFor: (id: string) => string | undefined;
  onSelect: (id: string) => void;
  onPlace: (assetId: string, position: Vector3Tuple) => void;
  onMoveSelected: (axis: 0 | 1 | 2, delta: number) => void;
  onDragStart: (assetId: string, event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
};

export function LeftSidebar({
  assets,
  objects,
  hasProject,
  selectedId,
  selectedObject,
  status,
  thumbnailFor,
  onSelect,
  onPlace,
  onMoveSelected,
  onDragStart,
  onDragEnd,
}: LeftSidebarProps) {
  const [sceneOpen, setSceneOpen] = useState(true);
  return (
    <aside
      className="border-r border-line pl-[1.5cqw] pr-[1cqw] py-[1.6cqh] overflow-y-auto max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:border-line max-[760px]:p-4 rounded-r-[32px] bg-[#F5F4F2]"
      aria-label="Assets and scene objects"
    >
      <section
        aria-labelledby="scene-tree-heading"
        className="@container mb-8 border-b border-line pb-5 max-[760px]:mb-4"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-[3cqw]">
            <img
              src="../public/icons/carbon_information.svg"
              alt="Information"
              className="size-[5cqw]"
            ></img>
            <h2 id="scene-tree-heading" className="text-[6cqw] font-[650] leading-none tracking-0 line-height-0 whitespace-nowrap">
              Scene Tree
            </h2>
          </div>
          <button
            type="button"
            aria-label="Toggle scene tree"
            className="flex size-[6cqw] items-center justify-center text-black transition-colors"
            aria-expanded={sceneOpen}
            onClick={() => setSceneOpen((open) => !open)}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className={`size-[6cqw] fill-none stroke-current stroke-[2] transition-transform [stroke-linecap:round] [stroke-linejoin:round] ${sceneOpen ? "rotate-90" : ""}`}
            >
              <path d="m9 5 5 5-5 5" />
            </svg>
          </button>
        </div>
        {sceneOpen && (
          <ul className="ml-[3rem] mt-[2rem] space-y-[0.15rem]">
            {objects.map((object) => (
              <li key={object.id}>
                <button
                  type="button"
                  className="flex items-center gap-[2cqw] border-l-2 border-l-transparent px-[4cqw] py-[1cqh] text-left text-[5cqw] hover:bg-tint-hover aria-pressed:border-l-sel aria-pressed:bg-tint"
                  aria-pressed={selectedId === object.id}
                  data-testid="object-row"
                  data-object-id={object.id}
                  onClick={() => onSelect(object.id)}
                >
                  <img
                    src={thumbnailFor(object.assetId)}
                    alt=""
                    draggable={false}
                    className="size-[4cqw] object-contain"
                  />
                  <span className="truncate">{object.name}</span>
                </button>
              </li>
            ))}
            {objects.length === 0 && (
              <li className=" py-[1cqh] text-[5cqw] text-muted">Empty scene</li>
            )}
          </ul>
        )}
        {selectedObject !== undefined && (
          <div
            className="mt-[0.9rem] rounded-lg border border-line p-[0.8rem] text-xs"
            role="group"
            aria-label={`Move ${selectedObject.name}`}
          >
            <p>Move selected · 0.25 m per step</p>
            <div className="my-[0.6rem] grid grid-cols-3 gap-[0.4rem]">
              {([0, 1, 2] as const).map((axis) =>
                ([-0.25, 0.25] as const).map((delta) => (
                  <button
                    key={`${axis}:${delta}`}
                    type="button"
                    className="min-h-[2.75rem] rounded-[0.3rem] border border-edge bg-white hover:bg-tint"
                    aria-label={`Move ${selectedObject.name} ${"XYZ"[axis]} ${delta > 0 ? "plus" : "minus"} 0.25 metres`}
                    onClick={() => onMoveSelected(axis, delta)}
                  >
                    {"XYZ"[axis]} {delta > 0 ? "+" : "−"}
                  </button>
                )),
              )}
            </div>
            <output aria-label="Selected position" className="block tabular-nums text-muted">
              {selectedObject.transform.position
                .map((value, axis) => `${"XYZ"[axis]} ${value.toFixed(2)}`)
                .join(" · ")}{" "}
              m
            </output>
          </div>
        )}
      </section>

      <section aria-labelledby="assets-heading">
        <h2
          id="assets-heading"
          className="whitespace-nowrap text-[0.9375rem] font-[650] tracking-[-0.015em]"
        >
          Asset library
        </h2>
        <ul
          className="mt-[1.2rem] grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4 max-[760px]:grid-cols-[repeat(auto-fill,minmax(8rem,10rem))]"
          role="list"
        >
          {assets
            .filter((asset) => !hasProject || asset.kind === "model")
            .map((asset) => (
              <li key={asset.id}>
                <button
                  className="group block w-full cursor-grab p-0 text-left active:cursor-grabbing"
                  type="button"
                  draggable={status === "ready"}
                  disabled={status !== "ready"}
                  aria-label={`Add ${asset.name}`}
                  title="Drag into the scene, or click to add"
                  onClick={() => onPlace(asset.id, [0, 0, 0])}
                  onDragStart={(event) => onDragStart(asset.id, event)}
                  onDragEnd={onDragEnd}
                >
                  <span
                    className="relative grid aspect-[1.1] place-items-center rounded-2xl border border-transparent bg-art transition-[background,transform] duration-150 group-enabled:hover:-translate-y-[3px] group-enabled:hover:bg-art-hover group-focus-visible:-translate-y-[3px] group-focus-visible:bg-art-hover motion-reduce:transition-none motion-reduce:group-enabled:hover:transform-none motion-reduce:group-focus-visible:transform-none"
                    data-testid="asset-art"
                  >
                    <img
                      src={thumbnailFor(asset.id)}
                      alt=""
                      draggable={false}
                      className="size-full object-contain pointer-events-none"
                    />
                    <span
                      className="absolute right-[0.65rem] bottom-[0.65rem] grid size-7 place-items-center rounded-[0.35rem] bg-paper text-[1.3rem] leading-none"
                      aria-hidden="true"
                    >
                      +
                    </span>
                  </span>
                  <span className="block px-[0.2rem] pt-[0.65rem] text-sm font-[550]">
                    {asset.name}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      </section>
    </aside>
  );
}
