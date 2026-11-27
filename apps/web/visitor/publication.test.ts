import fixture from "../shared/project/fixtures/m2-publication-project.json";
import { expect, it } from "vitest";
import { deferred } from "../tests/deferred";
import { serveHttp } from "../tests/http-fixture";
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

function servePublication(manifest: unknown, snapshot: unknown) {
  const path = `/api/v1/publications/${id}`;
  return serveHttp((request) => {
    switch (new URL(request.url).pathname) {
      case `${path}/manifest`:
        return Response.json(manifest);
      case path:
        return Response.json(snapshot);
      default:
        return new Response(null, { status: 404 });
    }
  });
}

async function openPublication(manifest: unknown, snapshot: unknown) {
  const server = await servePublication(manifest, snapshot);
  return loadPublication(id, new AbortController().signal, server.fetch);
}

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
it.each(["../room", "room?x=1", "room%2fother", "UPPERCASE", ""])(
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

it.each([
  [
    "moved and rotated",
    { environmentTransform: { position: [10, 0, 0], rotation: [0, 1, 0, 0], scale: [1, 1, 1] } },
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
  const manifest = { ...value, assets: [{ ...value.assets[0]!, kind: "environment" }] };
  await expect(openPublication(manifest, v1)).rejects.toThrow("format is not supported");
  expect((await openPublication(manifest, v2)).document.scenes[0]).toMatchObject(state);
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
  return { project, manifest };
}

it.each([false, true])("opens both v2 scenes with enabled rules set to %s", async (enabled) => {
  const { project, manifest } = v2Publication(enabled);
  const loaded = await openPublication(manifest, project);
  expect(loaded.document).toMatchObject(project);
  expect(loaded.assets.map(({ url }) => url)).toEqual(manifest.assets.map(({ url }) => url));
});

it("rejects a buffered snapshot with the original abort reason after access is revoked", async () => {
  const { project, manifest } = v2Publication();
  const server = await servePublication(manifest, project);
  const manifestRead = deferred<void>();
  const snapshotRead = deferred<void>();
  const releaseSnapshot = deferred<void>();
  const request: typeof fetch = async (input, init) => {
    const response = await server.fetch(input, init);
    await response.clone().arrayBuffer();
    if (response.url.endsWith("/manifest")) {
      manifestRead.resolve();
    } else {
      snapshotRead.resolve();
      await releaseSnapshot.promise;
    }
    return response;
  };
  const controller = new AbortController();
  const reason = new DOMException("Exhibition access was revoked", "AbortError");
  const opening = loadPublication(id, controller.signal, request);
  try {
    await Promise.race([opening, Promise.all([manifestRead.promise, snapshotRead.promise])]);
    controller.abort(reason);
  } finally {
    releaseSnapshot.resolve();
  }
  await expect(opening).rejects.toBe(reason);
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
  const { project, manifest } = v2Publication();
  Object.assign(project.scenes[0]!, {
    interactions: [
      {
        when: { type: "scene-starts" },
        do: { type: "play-audio", url: "https://example.com/track.m4a" },
      },
    ],
  });
  await expect(openPublication(manifest, project)).rejects.toThrow("approved library track");
});

it("retains captured bottom-center placement for non-room models", () => {
  const manifest = {
    ...value,
    assets: [{ ...value.assets[0], placement: "bottom-center" }],
  };
  expect(readPublicationManifest(manifest, id).assets[0]?.placement).toBe("bottom-center");
});
it("retains trusted non-blocking metadata for published models", () => {
  const manifest = {
    ...value,
    assets: [{ ...value.assets[0], nonBlocking: true }],
  };
  expect(readPublicationManifest(manifest, id).assets[0]?.nonBlocking).toBe(true);
});
it("treats explicit false non-blocking metadata as a normal obstacle", () => {
  const manifest = {
    ...value,
    assets: [{ ...value.assets[0], nonBlocking: false }],
  };
  expect(readPublicationManifest(manifest, id).assets[0]?.nonBlocking).toBeUndefined();
});
it.each(["true", 1, null])("rejects unsupported non-blocking metadata %s", (nonBlocking) => {
  expect(() =>
    readPublicationManifest(
      {
        ...value,
        assets: [{ ...value.assets[0], nonBlocking }],
      },
      id,
    ),
  ).toThrow();
});
it("rejects non-blocking metadata on non-model assets", () => {
  expect(() =>
    readPublicationManifest(
      {
        ...value,
        assets: [{ ...value.assets[0], kind: "audio", nonBlocking: true }],
      },
      id,
    ),
  ).toThrow();
});
it.each(["center", {}])("rejects unsupported placement metadata %s", (placement) => {
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

it("loads the student's V1 hotspot actions from the published snapshot", async () => {
  const objectId = "44444444-4444-4444-8444-444444444444";
  const hotspotId = "55555555-5555-4555-8555-555555555555";
  const source = {
    schemaVersion: 1,
    projectId: id,
    title: "Legacy exhibit",
    scenes: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Room",
        environmentAssetId: "room",
        startCamera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], fovDegrees: 40 },
        objects: [
          {
            id: objectId,
            assetId: asset,
            name: "Model",
            transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
        ],
        hotspots: [{ id: hotspotId, objectId, position: [0, 0, 0] }],
        interactions: [
          {
            when: { type: "visitor-clicks-hotspot", targetHotspotId: hotspotId },
            do: { type: "print-hi" },
          },
        ],
      },
    ],
  };
  const manifest = {
    ...value,
    assets: [
      ...value.assets,
      {
        ...value.assets[0],
        id: "room",
        kind: "environment",
        url: `/api/v1/publications/${id}/assets/room/bytes`,
      },
    ],
  };
  const loaded = await openPublication(manifest, source);
  expect(loaded.document.scenes[0]).toMatchObject({ interactions: source.scenes[0]!.interactions });
});

it("restores the display surface for a captured media stand by verified model hash", () => {
  const stand = {
    ...value.assets[0]!,
    sha256: "74cdcb81fa381cf6bb7754c657a2bf1341d3db0934c732e893f79fd3d2939998",
  };
  expect(readPublicationManifest({ ...value, assets: [stand] }, id).assets[0]).toMatchObject({
    placement: "bottom-center",
    displayRole: "digital",
    displaySurface: { width: 1.1, height: 0.63 },
  });
});
