import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createDisplayContent } from "./display-content";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { ContentObject } from "../../shared/project/project-content";

const surface = {
  position: [0, 1, 0] as const,
  rotation: [0, 0, 0, 1] as const,
  width: 1,
  height: 1,
};
const assets: CatalogueAsset[] = [
  {
    id: "stand",
    name: "Stand",
    kind: "model",
    url: "stand.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
    displayRole: "digital",
    displaySurface: surface,
  },
  {
    id: "movie",
    name: "Video",
    kind: "video",
    url: "/approved.mp4",
    sha256: "1".repeat(64),
    thumbnail: null,
  },
];
const object: ContentObject = {
  id: "object",
  assetId: "stand",
  name: "Stand",
  parentId: null,
  visible: true,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  components: [
    {
      id: "content",
      type: "video",
      assetId: "movie",
      caption: "Caption",
      loop: false,
      volume: 0.5,
    },
  ],
};
let video: {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  paused: boolean;
  muted?: boolean;
  src?: string;
  onloadeddata?: (() => void) | null;
  onerror?: (() => void) | null;
};

beforeEach(() => {
  video = {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn(),
    paused: true,
  };
  const context = {
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 10 }),
  };
  vi.stubGlobal("document", {
    hidden: false,
    createElement: (tag: string) =>
      tag === "video" ? video : { width: 0, height: 0, getContext: () => context },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("display resources", () => {
  it("plays silently while editing and requires explicit visitor playback", () => {
    const display = createDisplayContent(assets, vi.fn());
    display.sync([object], new Map([[object.id, new THREE.Group()]]));
    display.toggle(object.id);
    expect(video.play).not.toHaveBeenCalled();
    video.onloadeddata?.();
    expect(video.muted).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(1);
    display.setPreview(true);
    expect(video.muted).toBe(false);
    expect(video.pause).toHaveBeenCalled();
    expect(video.play).toHaveBeenCalledTimes(1);
    display.toggle(object.id);
    expect(video.play).toHaveBeenCalledTimes(2);
    display.setPreview(false);
    expect(video.muted).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(3);
    expect(video.pause).toHaveBeenCalled();
    display.dispose();
  });
  it("resumes editing videos after visibility returns without starting visitor playback", () => {
    const display = createDisplayContent(assets, vi.fn());
    display.sync([object], new Map([[object.id, new THREE.Group()]]));
    video.onloadeddata?.();
    video.play.mockClear();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    display.pause();
    display.resumeEditing();
    expect(video.play).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    display.resumeEditing();
    expect(video.play).toHaveBeenCalledTimes(1);
    display.setPreview(true);
    video.play.mockClear();
    display.pause();
    display.resumeEditing();
    expect(video.play).not.toHaveBeenCalled();
    display.dispose();
  });
  it.each([undefined] as const)("does not render legacy text on %s objects", (displayRole) => {
    const asset: CatalogueAsset = {
      ...(displayRole ? { displayRole } : {}),
      id: "sculpture",
      name: "Sculpture",
      kind: "model",
      url: "object.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    };
    const model = new THREE.Group();
    model.add(new THREE.Mesh(new THREE.BoxGeometry()));
    const owner = new THREE.Group();
    owner.add(model.clone(true));
    const display = createDisplayContent([asset], vi.fn());
    const text: ContentObject = {
      ...object,
      assetId: asset.id,
      components: [
        {
          id: "caption",
          type: "text",
          runs: [{ text: "Saved legacy text", marks: [] }],
          caption: "",
        },
      ],
    };
    display.sync([text], new Map([[text.id, owner]]));
    expect(owner.children).toHaveLength(1);
    expect(text.components).toHaveLength(1);
    display.dispose();
  });
  it("draws case text on alpha without a white rectangle and adapts to case color", () => {
    const asset: CatalogueAsset = {
      id: "case",
      name: "Case",
      kind: "model",
      url: "case.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
      displayRole: "physical",
      displayTop: 1,
    };
    const model = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.y = 0.5;
    model.add(mesh);
    const owner = new THREE.Group();
    owner.add(model.clone(true));
    const display = createDisplayContent([asset], vi.fn(), new Map([[asset.id, model]]));
    const text: ContentObject = {
      ...object,
      assetId: asset.id,
      appearance: { color: "#3d3133", material: "plain" },
      components: [
        { id: "caption", type: "text", runs: [{ text: "Case text", marks: [] }], caption: "" },
      ],
    };
    display.sync([text], new Map([[text.id, owner]]));
    const label = owner.getObjectByName("Display content")!.children[0] as THREE.Mesh<
      THREE.PlaneGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(label.material.transparent).toBe(true);
    const ctx = (label.material.map!.image as HTMLCanvasElement).getContext("2d")!;
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(ctx.fillStyle).toBe("#ffffff");
    display.dispose();
  });
  it("reuses unchanged content and releases media when its object disappears", () => {
    const display = createDisplayContent(assets, vi.fn());
    const owner = new THREE.Group();
    const owners = new Map([[object.id, owner]]);
    display.sync([object], owners);
    const group = owner.children[0];
    display.sync([object], owners);
    expect(owner.children).toEqual([group]);
    display.sync([], owners);
    expect(owner.children).toHaveLength(0);
    expect(video.pause).toHaveBeenCalled();
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.onloadeddata).toBe(null);
    display.dispose();
  });
  it("does not load a URL for an unregistered or wrong-kind media asset", () => {
    const display = createDisplayContent(
      assets.filter((asset) => asset.id !== "movie"),
      vi.fn(),
    );
    display.sync([object], new Map([[object.id, new THREE.Group()]]));
    expect(video.src).toBeUndefined();
    expect(video.load).not.toHaveBeenCalled();
    display.dispose();
  });
});
