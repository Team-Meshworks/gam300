import assert from "node:assert/strict";
import { launchPersistentBrowser } from "./browser-security.mjs";
import { openSavedProject, serveProject } from "./authoring-project-fixture.mjs";

const target = process.argv[2] ?? "http://127.0.0.1:5197/";
const browser = await launchPersistentBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 1024 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = await serveProject(page, target);
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  const stage = page.locator(".viewport-stage");
  const chooseRoom = async (name) => {
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page
      .getByRole("group", { name: "Rooms options" })
      .getByRole("button", { name, exact: true })
      .click();
  };
  const scene = async (matches) => {
    const deadline = Date.now() + 15000;
    let latest;
    while (Date.now() < deadline) {
      latest = project.document().scenes[0];
      if (latest && matches(latest)) return latest;
      await page.waitForTimeout(100);
    }
    throw new Error(`Expected scene was not saved: ${JSON.stringify(latest)}`);
  };
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  assert.equal(
    await page.locator(".room-picker-hint").innerText(),
    "Choose a room to add it to your scene. Adding another room requires an approved room model.",
  );
  await page.getByRole("button", { name: "Close rooms", exact: true }).click();
  await chooseRoom("Door 1");
  if (await stage.getAttribute("data-placing-asset"))
    await stage.click({ position: { x: 700, y: 480 } });
  await scene((value) => value.environmentAssetId === "room-doors-1-v1");

  await page.evaluate(async () => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const { editorModelCache } = await import("/graphics/scene.ts");
    const lease = await editorModelCache.acquire(
      assets.find((asset) => asset.id === "room-doors-2-v1"),
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
  await chooseRoom("Door 2");
  await page
    .locator('.viewport-stage[data-placing-asset="room-doors-2-v1"]')
    .waitFor({ timeout: 60000 })
    .catch(async () => {
      const feedback = await page.locator('[role="alert"], [role="status"]').allTextContents();
      throw new Error(
        `A second non-Starter room must enter positionable placement instead of replacing the layout: ${feedback.join(" | ")}`,
      );
    });
  const feedback = await page.locator('[role="alert"], [role="status"]').allTextContents();
  let validPoint;
  const previews = [];
  for (const y of [200, 300, 400, 500, 600, 700, 800]) {
    for (const x of [450, 600, 750, 900, 1050, 1200, 1350]) {
      await stage.hover({ position: { x, y } });
      await page.waitForTimeout(50);
      const preview = await page.evaluate(() => {
        let color;
        window.roomGhost?.traverse((node) => {
          if (node.isMesh) color = node.material.color.getHexString();
        });
        return {
          visible: window.roomGhost?.visible,
          color,
          position: window.roomGhost?.position.toArray(),
        };
      });
      previews.push(preview);
      if (preview.visible && preview.color === "999999") {
        validPoint = { x, y };
        break;
      }
    }
    if (validPoint) break;
  }
  assert.ok(
    validPoint,
    `Expected a valid room preview: ${feedback.join(" | ")} ${JSON.stringify(previews)}`,
  );
  await stage.click({ position: validPoint });
  await page.waitForTimeout(1000);
  assert.equal(
    await page.locator(".scene-tree .object-row").count(),
    1,
    `Click at ${JSON.stringify(validPoint)} preview ${JSON.stringify(previews.at(-1))}: ${(await page.locator('[role="alert"], [role="status"]').allTextContents()).join(" | ")}`,
  );
  const added = await scene((value) => value.objects.length === 1);
  const room = added.objects[0];
  const matchingAsset = await page.evaluate(async (id) => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const placed = assets.find((asset) => asset.id === id);
    const source = assets.find((asset) => asset.id === "room-doors-2-v1");
    const first = assets.find((asset) => asset.id === "room-doors-1-v1");
    return {
      kind: placed?.kind,
      sha: placed?.sha256,
      sourceSha: source?.sha256,
      firstBounds: first.boundsMeters,
      sourceBounds: source.boundsMeters,
    };
  }, room.assetId);
  assert.equal(matchingAsset.kind, "model", "The additional room is a placeable model");
  assert.equal(matchingAsset.sha, matchingAsset.sourceSha, "The chosen room model is preserved");
  assert.equal(added.environmentAssetId, "room-doors-1-v1", "The initial layout is retained");
  assert.ok(
    room.transform.position.some((coordinate) => Math.abs(coordinate) > 0.01),
    "Added room does not overlap the initial room",
  );
  const halfSum = (axis) =>
    (matchingAsset.firstBounds.max[axis] -
      matchingAsset.firstBounds.min[axis] +
      matchingAsset.sourceBounds.max[axis] -
      matchingAsset.sourceBounds.min[axis]) /
    2;
  const firstPosition = added.environmentTransform?.position ?? [0, 0, 0];
  const px = room.transform.position[0] - firstPosition[0];
  const pz = room.transform.position[2] - firstPosition[2];
  assert.ok(
    (Math.abs(Math.abs(px) - halfSum(0)) < 0.1 && Math.abs(pz) < halfSum(2)) ||
      (Math.abs(Math.abs(pz) - halfSum(2)) < 0.1 && Math.abs(px) < halfSum(0)),
    "Placement snaps the distinct room bounds to an adjacent edge",
  );
  const beforeReload = await scene((value) => value.objects.length === 1);
  const savedFile = project.document();
  await page.reload();
  await openSavedProject(page);
  const restored = await scene((value) => value.objects.length === 1);
  assert.equal(restored.environmentAssetId, beforeReload.environmentAssetId);
  assert.deepEqual(
    restored.objects,
    beforeReload.objects,
    "Server reload restores the placed room",
  );
  await page.locator(".scene-tree .object-row").last().click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const x = page.getByRole("textbox", { name: `${room.name} transform X (m)`, exact: true });
  const z = page.getByRole("textbox", { name: `${room.name} transform Z (m)`, exact: true });
  await x.fill("100");
  await x.press("Enter");
  assert.ok(Number(await x.inputValue()) < 100, "The room cannot move beyond the grid");
  await x.fill(String(firstPosition[0]));
  await x.press("Enter");
  await z.fill(String(firstPosition[2]));
  await z.press("Enter");
  assert.ok(
    Math.abs(Number(await x.inputValue()) - firstPosition[0]) > 0.01 ||
      Math.abs(Number(await z.inputValue()) - firstPosition[2]) > 0.01,
    "Moving a room onto another room is rejected",
  );
  // A legacy project can contain a loose object just outside a room. A move that
  // is clear before snapping must not snap the other room's wall through it.
  const targetZ = halfSum(2);
  const fixture = structuredClone(savedFile);
  fixture.scenes[0].objects[0].transform.position = [0, 0, -targetZ - 3];
  fixture.scenes[0].objects.push({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Loose crate",
    assetId: "test-crate-v1",
    parentId: null,
    visible: true,
    components: [],
    transform: {
      position: [0, 0, -(matchingAsset.firstBounds.max[2] - matchingAsset.firstBounds.min[2]) / 2],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  });
  project.setDocument(fixture);
  await page.reload();
  await openSavedProject(page);
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  if (!(await page.getByText("Loose crate", { exact: true }).isVisible()))
    await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await page
    .getByText("Loose crate", { exact: true })
    .waitFor({ timeout: 10000 })
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
  await page.locator(".scene-tree .object-row").filter({ hasText: room.name }).click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  await z.fill(String(-targetZ - 1));
  await z.press("Enter");
  const blockedPosition = Number(await z.inputValue());
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await page.getByText("Loose crate", { exact: true }).click();
  await page.keyboard.press("Delete");
  await page.locator(".scene-tree .object-row").filter({ hasText: room.name }).click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  await z.fill(String(-targetZ - 3));
  await z.press("Enter");
  await z.fill(String(-targetZ - 1));
  await z.press("Enter");
  assert.ok(
    Math.abs(Number(await z.inputValue()) + targetZ) < 0.1,
    "Without the crate the same room move snaps to its neighbour",
  );
  assert.ok(
    blockedPosition < -targetZ - 2,
    `A snap cannot place the room wall through a stationary loose crate; got ${blockedPosition}`,
  );
  assert.deepEqual(errors, []);
  console.log("Non-Starter room placement and room collision passed.");
} finally {
  await browser.close();
}
