import fixture from "../shared/project/fixtures/m2-publication-project.json";
import { afterEach, expect, it, vi } from "vitest";
import { validateProject } from "../shared/project/project-validation";
import { loadPublication, readPublicationManifest } from "./publication";
const id = "11111111-1111-4111-8111-111111111111";
const asset = "22222222-2222-4222-8222-222222222222";
const value = {
  publicationId: id,
  projectId: id,
  sourceRevision: 3,
  assets: [
    {
      id: asset,
      kind: "model",
      sha256: "a".repeat(64),
      url: `/api/v1/publications/${id}/assets/${asset}/bytes`,
    },
  ],
};
it("uses only assets bound to the requested publication", () => {
  expect(readPublicationManifest(value, id).assets[0]?.url).toBe(value.assets[0]?.url);
});
it("accepts a captured built-in room with a publication-bound URL", () => {
  const room = "test-room-v1";
  const manifest = {
    ...value,
    assets: [
      {
        id: room,
        kind: "environment",
        sha256: "a".repeat(64),
        url: `/api/v1/publications/${id}/assets/${room}/bytes`,
      },
    ],
  };
  expect(readPublicationManifest(manifest, id).assets[0]?.id).toBe(room);
});
it.each(["../room", "room/../../other", "room?x=1", "room%2fother", "UPPERCASE", ""])(
  "rejects unsafe built-in asset identity %s",
  (assetId) => {
    expect(() =>
      readPublicationManifest(
        {
          ...value,
          assets: [
            {
              id: assetId,
              kind: "environment",
              sha256: "a".repeat(64),
              url: `/api/v1/publications/${id}/assets/${assetId}/bytes`,
            },
          ],
        },
        id,
      ),
    ).toThrow();
  },
);
it.each([
  "https://elsewhere.test/asset.glb",
  `/api/v1/assets/${asset}/bytes`,
  `/api/v1/publications/${asset}/assets/${asset}/bytes`,
])("rejects an unrelated asset URL", (url) => {
  expect(() =>
    readPublicationManifest({ ...value, assets: [{ ...value.assets[0], url }] }, id),
  ).toThrow();
});
it("rejects mismatched editions and duplicate asset identities", () => {
  expect(() => readPublicationManifest(value, asset)).toThrow();
  expect(() =>
    readPublicationManifest({ ...value, assets: [value.assets[0], value.assets[0]] }, id),
  ).toThrow();
});

afterEach(() => vi.unstubAllGlobals());

it.each([
  [
    "moved",
    { environmentTransform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ],
  [
    "rotated",
    { environmentTransform: { position: [0, 0, 0], rotation: [0, 1, 0, 0], scale: [1, 1, 1] } },
  ],
  ["hidden", { environmentVisible: false }],
])("preserves a %s v2 initial room and rejects it in v1", async (_, state) => {
  const scene = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Room",
    environmentAssetId: asset,
    startCamera: { position: [0, 1, 0], rotation: [0, 0, 0, 1], fovDegrees: 40 },
    objects: [],
    ...state,
  };
  const v1 = { schemaVersion: 1, projectId: id, title: "Room", scenes: [scene] };
  const v2 = {
    ...v1,
    schemaVersion: 2,
    scenes: [{ ...scene, groups: [], zones: [], viewpoints: [], rules: [] }],
  };
  expect(validateProject(v2, new Map([[asset, "environment"]])).ok).toBe(true);
  const manifest = { ...value, assets: [{ ...value.assets[0]!, kind: "environment" }] };
  for (const snapshot of [v1, v2]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(url.endsWith("/manifest") ? manifest : snapshot)),
      ),
    );
    if (snapshot.schemaVersion === 1) {
      await expect(loadPublication(id, new AbortController().signal)).rejects.toThrow();
    } else {
      expect(
        (await loadPublication(id, new AbortController().signal)).document.scenes[0],
      ).toMatchObject(state);
    }
  }
});

function v2Publication(enabled = false) {
  const project = structuredClone(fixture);
  project.projectId = id;
  for (const scene of project.scenes) {
    scene.environmentAssetId = asset;
    for (const object of scene.objects) {
      object.assetId = "44444444-4444-4444-8444-444444444444";
    }
  }
  project.scenes[0]!.rules[0]!.enabled = enabled;
  const manifest = {
    ...value,
    assets: [
      { ...value.assets[0]!, kind: "environment" },
      {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "model",
        sha256: "b".repeat(64),
        url: `/api/v1/publications/${id}/assets/44444444-4444-4444-8444-444444444444/bytes`,
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(url.endsWith("/manifest") ? manifest : project)),
    ),
  );
  return { project };
}

it.each([false, true])("opens both v2 scenes with enabled rules set to %s", async (enabled) => {
  const { project } = v2Publication(enabled);
  expect((await loadPublication(id, new AbortController().signal)).document).toMatchObject(project);
});

it.each(["audio", "image", "video"])(
  "retains only publication-bound %s bytes in the manifest",
  (kind) => {
    expect(
      readPublicationManifest({ ...value, assets: [{ ...value.assets[0], kind }] }, id).assets[0]
        ?.kind,
    ).toBe(kind);
  },
);

it("rejects URL-only audio rather than silently fetching media outside the captured edition", async () => {
  const { project } = v2Publication();
  Object.assign(project.scenes[0]!, {
    interactions: [
      {
        when: { type: "scene-starts" },
        do: { type: "play-audio", url: "https://example.com/track.m4a" },
      },
    ],
  });
  await expect(loadPublication(id, new AbortController().signal)).rejects.toThrow(
    "approved library track",
  );
});

it("retains captured bottom-center placement for non-room models", () => {
  const manifest = {
    ...value,
    assets: [{ ...value.assets[0], placement: "bottom-center" }],
  };
  expect(readPublicationManifest(manifest, id).assets[0]?.placement).toBe("bottom-center");
});
it.each(["center", {}, 1])("rejects unsupported placement metadata %s", (placement) => {
  expect(() =>
    readPublicationManifest(
      {
        ...value,
        assets: [{ ...value.assets[0], placement }],
      },
      id,
    ),
  ).toThrow();
});
it("rejects model placement on non-model assets", () => {
  expect(() =>
    readPublicationManifest(
      {
        ...value,
        assets: [{ ...value.assets[0], kind: "audio", placement: "bottom-center" }],
      },
      id,
    ),
  ).toThrow();
});
