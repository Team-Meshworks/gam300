import { describe, it, expect } from "vitest";
import { createDocumentStore } from "./document-store";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { displayPosition } from "./display-position";
import type { ContentObject } from "../shared/project/project-content";
const assets: CatalogueAsset[] = [
  {
    id: "room",
    name: "Room",
    kind: "environment",
    url: "room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
  {
    id: "stand",
    name: "Stand",
    kind: "model",
    displayRole: "digital",
    url: "stand.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
  {
    id: "photo",
    name: "Photo",
    kind: "image",
    url: "photo.png",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
  {
    id: "video",
    name: "Video",
    kind: "video",
    url: "video.mp4",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
];
function setup() {
  const store = createDocumentStore(assets);
  store.createProject("room");
  const result = store.addObject("stand", [0, 0, 0]);
  if (!result.ok) throw new Error(result.error);
  return { store, object: result.object };
}
describe("display authoring", () => {
  it("stores literal formatted text and restores it with undo and redo", () => {
    const { store, object } = setup();
    const before = store.getSnapshot().project;
    const content = {
      id: crypto.randomUUID(),
      type: "text" as const,
      runs: [{ text: "<script>Literal text</script>", marks: ["bold" as const] }],
      caption: "Caption",
    };
    expect(store.setDisplayContent(object.id, content)).toMatchObject({ ok: true });
    expect((store.getSnapshot().objects[0] as ContentObject).components).toEqual([content]);
    store.undo();
    expect(store.getSnapshot().project).toEqual(before);
    store.redo();
    expect((store.getSnapshot().objects[0] as ContentObject).components).toEqual([content]);
  });
  it("accepts registered media, replaces atomically and rejects unknown media", () => {
    const { store, object } = setup();
    const image = {
      id: crypto.randomUUID(),
      type: "image" as const,
      assetId: "photo",
      caption: "",
      alt: "",
    };
    expect(store.setDisplayContent(object.id, image)).toMatchObject({ ok: true });
    const before = store.getSnapshot();
    expect(store.setDisplayContent(object.id, { ...image, assetId: "unknown" }).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(
      store.setDisplayContent(object.id, {
        id: image.id,
        type: "video",
        assetId: "video",
        caption: "",
        loop: false,
        volume: 1,
      }).ok,
    ).toBe(true);
    expect((store.getSnapshot().objects[0] as ContentObject).components).toHaveLength(1);
    expect(store.setDisplayContent(object.id, null).ok).toBe(true);
    expect((store.getSnapshot().objects[0] as ContentObject).components).toEqual([]);
    store.undo();
    expect((store.getSnapshot().objects[0] as ContentObject).components[0]?.type).toBe("video");
  });
  it("transforms the local support height into world coordinates", () => {
    const { object } = setup();
    expect(
      displayPosition(
        {
          ...object,
          transform: {
            position: [1, 2, 3],
            rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
            scale: [1, 2, 1],
          },
        },
        1,
      )[0],
    ).toBeCloseTo(-1);
  });
});
