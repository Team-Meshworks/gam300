import { expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
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
it("accepts an operator-expanded catalogue beyond the original capacity", async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => {
    const entryId = `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`;
    return { ...asset, id: entryId, url: `/api/v1/assets/${entryId}/bytes` };
  });
  const { fetch: fetcher } = await serveResponses(Response.json(rows));
  expect(await readServerAssets("alice", new AbortController().signal, fetcher)).toHaveLength(1001);
});

it("keeps an expanded catalogue bounded", async () => {
  const { fetch: fetcher } = await serveResponses(Response.json(Array(100001).fill(asset)));
  await expect(readServerAssets("alice", new AbortController().signal, fetcher)).rejects.toThrow();
});
it("retains measured room geometry for an approved matching room asset", async () => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../../../assets/manifest.json", import.meta.url), "utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("assets" in manifest) ||
    !Array.isArray(manifest.assets)
  )
    throw new Error("Invalid asset manifest");
  const room: unknown = manifest.assets.find(
    (entry: unknown) =>
      entry !== null &&
      typeof entry === "object" &&
      "assetId" in entry &&
      entry.assetId === "room-doors-1-v1",
  );
  if (
    !room ||
    typeof room !== "object" ||
    !("sha256" in room) ||
    typeof room.sha256 !== "string" ||
    !("boundsMeters" in room)
  )
    throw new Error("Missing measured room fixture");
  const { fetch: fetcher } = await serveResponses(
    Response.json([{ ...asset, sha256: room.sha256 }]),
  );
  const [loaded] = await readServerAssets("alice", new AbortController().signal, fetcher);
  expect(loaded?.boundsMeters).toEqual(room.boundsMeters);
  expect(loaded?.placement).toBe("bottom-center");
});
it("loads retained references independently of the active catalogue using project-scoped bytes", async () => {
  const projectId = "22222222-2222-4222-8222-222222222222";
  const retained = { ...asset, url: `/api/v1/projects/${projectId}/assets/${id}/bytes` };
  const { fetch: fetcher } = await serveHttp(({ url }) =>
    Response.json(
      new URL(url).pathname === `/api/v1/projects/${projectId}/assets` ? [retained] : [],
    ),
  );
  expect(await readServerAssets("alice", new AbortController().signal, fetcher, projectId)).toEqual(
    [{ ...retained, category: undefined }],
  );
});
it("loads approved server identities and uses authenticated uncached requests", async () => {
  const { fetch: fetcher, requests } = await serveResponses(Response.json([asset]));
  expect(await readServerAssets("alice", new AbortController().signal, fetcher)).toEqual([
    { ...asset, category: undefined },
  ]);
  expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/assets");
  expect(requests[0]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  expect(requests[0]!.headers.get("X-Spatia-Account")).toBe("alice");
});
it.each([
  [asset, asset],
  [{ ...asset, url: "https://outside.invalid/room.glb" }],
  [{ ...asset, kind: "unknown" }],
  [{ ...asset, sha256: "invalid" }],
])("rejects malformed or ambiguous catalogue entries", async (...rows) => {
  const { fetch: fetcher } = await serveResponses(Response.json(rows));
  await expect(readServerAssets("alice", new AbortController().signal, fetcher)).rejects.toThrow();
});
it("keeps catalogue failures explicit", async () => {
  const { fetch: fetcher } = await serveResponses(new Response(null, { status: 503 }));
  await expect(readServerAssets("alice", new AbortController().signal, fetcher)).rejects.toThrow();
});
