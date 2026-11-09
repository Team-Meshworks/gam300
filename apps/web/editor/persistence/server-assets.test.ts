import { expect, it, vi } from "vitest";
import { readServerAssets } from "./server-assets";
import { readFileSync } from "node:fs";

const id = "11111111-1111-4111-8111-111111111111";
const asset = {
  id,
  name: "Approved room",
  kind: "environment",
  url: `/api/v1/assets/${id}/bytes`,
  sha256: "a".repeat(64),
  thumbnail: null,
  category: null,
};
it("retains measured room geometry for an approved matching room asset", async () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../../assets/manifest.json", import.meta.url), "utf8"),
  );
  const room = manifest.assets.find(
    (entry: { assetId: string }) => entry.assetId === "room-doors-1-v1",
  );
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json([{ ...asset, sha256: room.sha256 }]));
  const [loaded] = await readServerAssets("alice", new AbortController().signal, fetcher);
  expect(loaded?.boundsMeters).toEqual(room.boundsMeters);
  expect(loaded?.placement).toBe("bottom-center");
});
it("loads retained references independently of the active catalogue using project-scoped bytes", async () => {
  const projectId = "22222222-2222-4222-8222-222222222222";
  const retained = { ...asset, url: `/api/v1/projects/${projectId}/assets/${id}/bytes` };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      Response.json(url === `/api/v1/projects/${projectId}/assets` ? [retained] : []),
    );
  expect(await readServerAssets("alice", new AbortController().signal, fetcher, projectId)).toEqual(
    [{ ...retained, category: undefined }],
  );
});
it("loads approved server identities and uses authenticated uncached requests", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([asset]));
  expect(await readServerAssets("alice", new AbortController().signal, fetcher)).toEqual([
    { ...asset, category: undefined },
  ]);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/assets",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Spatia-Account": "alice" },
    }),
  );
});
it.each([
  [asset, asset],
  [{ ...asset, url: "https://outside.invalid/room.glb" }],
  [{ ...asset, kind: "unknown" }],
  [{ ...asset, sha256: "invalid" }],
])("rejects malformed or ambiguous catalogue entries", async (...rows) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(rows));
  await expect(readServerAssets("alice", new AbortController().signal, fetcher)).rejects.toThrow();
});
it("keeps catalogue failures explicit", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  await expect(readServerAssets("alice", new AbortController().signal, fetcher)).rejects.toThrow();
});
