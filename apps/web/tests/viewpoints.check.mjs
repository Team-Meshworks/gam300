import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject, openSavedProject } from "./authoring-project-fixture.mjs";

const target = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const project = await serveProject(page, target);
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: /^Scene Tree/ }).count(),
    1,
    "Scene Tree heading is present before creating a scene",
  );
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  assert.equal(
    await page.getByRole("heading", { name: "Saved Views", exact: true }).count(),
    1,
    "Saved Views heading is present before creating a scene",
  );
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  await page.locator(".viewport-stage").click({ position: { x: 500, y: 300 } });
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const tree = page.getByRole("heading", { name: /^Scene Tree/ });
  assert.equal(await tree.count(), 1, "Scene tree remains accessible after placement");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const views = page.getByRole("heading", { name: "Saved Views", exact: true });
  await views.waitFor();
  const add = page.getByRole("button", { name: "+ Add View", exact: true });
  const first = page.getByRole("button", { name: "1. Default View", exact: true });
  await first.waitFor();
  const card = page.locator(".saved-view-card").first();
  const restingFill = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
  await first.hover();
  assert.equal(
    await card.evaluate((element) => getComputedStyle(element).backgroundColor),
    restingFill,
  );
  assert.notEqual(
    await card.evaluate((element) => getComputedStyle(element).backgroundImage),
    "none",
  );
  const bounds = await card.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const parent = element.closest("fieldset").getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      parentLeft: parent.left,
      parentRight: parent.right,
      border: getComputedStyle(element).borderLeftWidth,
    };
  });
  assert.equal(bounds.border, "2px");
  assert.ok(bounds.left >= bounds.parentLeft && bounds.right <= bounds.parentRight);

  assert.equal(await page.getByRole("button", { name: "Go to view", exact: true }).count(), 0);
  if (process.env.CHECK_SCREENSHOT)
    await page.screenshot({ path: process.env.CHECK_SCREENSHOT.replace(".png", "-list.png") });
  await first.click();
  await page.getByRole("button", { name: "Go to view", exact: true }).waitFor();
  const beforeRename = await page.locator(".saved-views-shell").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const row = panel.querySelector(".saved-view-card").getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rowHeight: row.height };
  });
  await first.dblclick();
  const duringRename = await page.locator(".saved-views-shell").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const row = panel.querySelector(".saved-view-card").getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rowHeight: row.height };
  });
  assert.deepEqual(duringRename, beforeRename);

  assert.equal(
    await page.getByRole("button", { name: "Go to view", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Set as starting view", exact: true }).isDisabled(),
    true,
  );
  const name = page.getByRole("textbox", { name: "View name", exact: true });
  await name.fill("Browser view");
  await name.press("Enter");
  const renamed = page.getByRole("button", { name: "1. Browser view", exact: true });
  await renamed.waitFor();
  await renamed.dblclick();
  await name.fill("Cancelled rename");
  await name.press("Escape");
  await renamed.waitFor();
  await renamed.dblclick();
  await name.fill(" ");
  await name.press("Enter");
  await page
    .getByText("Enter a viewpoint name between 1 and 120 characters", { exact: true })
    .waitFor();
  await name.fill("Browser view");
  await name.press("Enter");
  await add.click();
  const second = page.getByRole("button", { name: "2. View 2", exact: true });
  await second.click();
  await page.getByRole("button", { name: "Set as starting view", exact: true }).click();
  await page.getByText("Starting view saved. Undo is available.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Go to view", exact: true }).click();
  const saved = await project.waitForDocument((doc) => doc.scenes[0]?.viewpoints?.length === 2);
  assert.equal(saved.scenes[0].viewpoints[0].name, "Browser view");
  assert.deepEqual(saved.scenes[0].startCamera, saved.scenes[0].viewpoints[1].camera);
  await page.getByRole("button", { name: "Reorder View 2", exact: true }).press("ArrowUp");
  await page.getByRole("button", { name: "1. View 2", exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await second.waitFor();
  const dropTarget = page.locator(".saved-view-card").nth(1);
  const dropBounds = await dropTarget.boundingBox();
  await page
    .getByRole("button", { name: "Reorder Browser view", exact: true })
    .dragTo(dropTarget, { targetPosition: { x: dropBounds.width / 2, y: dropBounds.height - 4 } });
  await page.getByRole("button", { name: "1. View 2", exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await second.waitFor();
  await page.getByRole("button", { name: "Delete view Browser view", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "Confirm view deletion" });
  assert.match(await confirmation.innerText(), /navigation points.*rules.*Undo restores/s);
  const confirmationGaps = await confirmation.evaluate((group) => {
    const heading = group.querySelector("h3");
    const style = getComputedStyle(heading);
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = canvas.measureText(heading.textContent);
    const inkOffset =
      (parseFloat(style.lineHeight) - text.fontBoundingBoxAscent - text.fontBoundingBoxDescent) /
        2 +
      text.fontBoundingBoxAscent -
      text.actualBoundingBoxAscent;
    const panel = group.closest(".saved-views-shell").getBoundingClientRect();
    const buttons = group.querySelector(".saved-view-confirm-actions").getBoundingClientRect();
    return {
      top: heading.getBoundingClientRect().top + inkOffset - group.getBoundingClientRect().top,
      bottom: panel.bottom - buttons.bottom,
    };
  });
  console.log("Delete confirmation visible gaps", confirmationGaps);
  assert.ok(
    Math.abs(confirmationGaps.top - confirmationGaps.bottom) < 1,
    JSON.stringify(confirmationGaps),
  );

  assert.equal(await add.count(), 0);
  assert.equal(await page.getByRole("button", { name: "Go to view", exact: true }).count(), 0);
  if (process.env.CHECK_SCREENSHOT) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.screenshot({ path: process.env.CHECK_SCREENSHOT.replace(".png", "-delete.png") });
  }
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await renamed.waitFor();
  await page.getByRole("button", { name: "Delete view Browser view", exact: true }).click();
  await confirmation.getByRole("button", { name: "Confirm delete view", exact: true }).click();
  assert.equal(await renamed.count(), 0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await renamed.waitFor();
  await renamed.dblclick();
  await name.fill("View 3");
  await name.press("Enter");
  await add.click();
  await page.getByRole("button", { name: "3. View 4", exact: true }).waitFor();
  const numbered = await project.waitForDocument((doc) => doc.scenes[0]?.viewpoints?.length === 3);
  assert.deepEqual(
    numbered.scenes[0].viewpoints.map((entry) => entry.name),
    ["View 3", "View 2", "View 4"],
  );
  await page.getByText("Saved", { exact: true }).waitFor();
  const persisted = project.document();
  await page.reload();
  await openSavedProject(page);
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByRole("button", { name: "1. View 3", exact: true }).waitFor();
  await page.getByRole("button", { name: "2. View 2", exact: true }).waitFor();
  await page.getByRole("button", { name: "3. View 4", exact: true }).waitFor();
  assert.equal(await page.locator(".saved-view-card").count(), 3);
  assert.deepEqual(project.document().scenes[0].viewpoints, persisted.scenes[0].viewpoints);
  assert.deepEqual(project.document().scenes[0].startCamera, persisted.scenes[0].startCamera);
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "2. View 2", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Set as starting view", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Go to view", exact: true }).click();
  await page.getByRole("button", { name: "+ Add View", exact: true }).click();
  const recaptured = await project.waitForDocument(
    (doc) => doc.scenes[0]?.viewpoints?.length === 4,
  );
  const expectedPose = persisted.scenes[0].viewpoints[1].camera;
  const actualPose = recaptured.scenes[0].viewpoints[3].camera;
  for (const key of ["position", "rotation"]) {
    actualPose[key].forEach((value, index) =>
      assert.ok(
        Math.abs(value - expectedPose[key][index]) < 0.0001,
        `${key}: ${value} != ${expectedPose[key][index]}`,
      ),
    );
  }
  assert.equal(actualPose.fovDegrees, expectedPose.fovDegrees);
  console.log(
    "Saved views survive a fresh editor page with identical IDs, order, poses and starting camera; Go to view restores the captured pose.",
  );
  if (process.env.CHECK_SCREENSHOT) await page.screenshot({ path: process.env.CHECK_SCREENSHOT });
  console.log(
    "Saved Views add, inline rename, selection, starting view, reorder, delete and undo passed",
  );
} finally {
  await browser.close();
}
