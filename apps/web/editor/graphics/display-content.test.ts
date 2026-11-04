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
  it("only starts video on explicit preview activation and pauses on exit", () => {
    const display = createDisplayContent(assets, vi.fn());
    display.sync([object], new Map([[object.id, new THREE.Group()]]));
    display.toggle(object.id);
    expect(video.play).not.toHaveBeenCalled();
    display.setPreview(true);
    expect(video.play).not.toHaveBeenCalled();
    display.toggle(object.id);
    expect(video.play).toHaveBeenCalledTimes(1);
    display.setPreview(false);
    expect(video.pause).toHaveBeenCalled();
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
