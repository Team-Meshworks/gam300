import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5185/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.evaluate(async () => {
    const { editorModelCache } = await import("/graphics/scene.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const lease = await editorModelCache.acquire(
      assets.find((asset) => asset.id === "test-room-v1"),
      new AbortController().signal,
    );
    const prototype = Object.getPrototypeOf(Object.getPrototypeOf(lease.value.model));
    const add = prototype.add;
    prototype.add = function (...nodes) {
      for (const node of nodes) if (node.name === "placement-preview") window.roomGhost = node;
      return add.apply(this, nodes);
    };
    lease.release();
  });
  async function choose() {
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page
      .getByRole("group", { name: "Rooms options", exact: true })
      .getByRole("button", { name: "test-room", exact: true })
      .click();
  }
  async function saved(count) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const doc = await page.evaluate(async () => {
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
        const r = await loadRecoverySession(new Map(assets.map((a) => [a.id, a.kind])));
        return r.ok ? r.value?.document : null;
      });
      if (doc?.scenes[0].objects.length === count) return doc;
      await page.waitForTimeout(100);
    }
    throw new Error("Room placement did not reach storage");
  }
  const stage = page.locator(".viewport-stage");
  await choose();
  await stage.click({ position: { x: 600, y: 350 } });
  let doc = await saved(0);
  for (let count = 1; count <= 2; count++) {
    await choose();
    await stage.hover({ position: { x: 600, y: 350 } });
    const preview = await page.evaluate(() => {
      const ghost = window.roomGhost;
      ghost.updateMatrixWorld(true);
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      ghost.traverse((node) => {
        const points = node.geometry?.attributes.position;
        if (!points) return;
        const e = node.matrixWorld.elements;
        for (let i = 0; i < points.count; i++) {
          const x = points.getX(i),
            y = points.getY(i),
            z = points.getZ(i);
          const point = [
            e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14],
          ];
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], point[axis]);
            max[axis] = Math.max(max[axis], point[axis]);
          }
        }
      });
      return { position: ghost.position.toArray(), min, max };
    });
    for (const position of [[0, 0, 0], ...doc.scenes[0].objects.map((o) => o.transform.position)]) {
      const overlapX =
          Math.min(preview.max[0], position[0] + 5) - Math.max(preview.min[0], position[0] - 5),
        overlapZ =
          Math.min(preview.max[2], position[2] + 5) - Math.max(preview.min[2], position[2] - 5);
      assert.ok(
        overlapX < 1e-5 || overlapZ < 1e-5,
        "Unplaced floor must not overlap an existing room floor",
      );
    }
    await stage.click({ position: { x: 600, y: 350 } });
    doc = await saved(count);
    assert.deepEqual(doc.scenes[0].objects.at(-1).transform.position, preview.position);
  }
  console.log(
    "PASS: second and third room previews avoid overlapping floors and match committed positions.",
  );
} finally {
  await browser.close();
}
