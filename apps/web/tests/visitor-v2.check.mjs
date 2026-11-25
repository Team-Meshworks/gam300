import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "./browser-security.mjs";
import { blankProject } from "./authoring-project-fixture.mjs";
import { checkNativeMedia } from "./native-media-cases.mjs";
import { withVisibilityPage } from "./page-visibility.mjs";

// Run the real-media component fixture independently while publication gates are being verified
if (process.argv.includes("--playback-only")) {
  await checkPlayback();
} else {
  const origin = process.argv[2] ?? "http://127.0.0.1:5181";
  const publicationId = "11111111-1111-4111-8111-111111111111";
  const environmentId = "22222222-2222-4222-8222-222222222222";
  const modelId = "33333333-3333-4333-8333-333333333333";
  const snapshot = JSON.parse(
    await readFile(
      new URL("../shared/project/fixtures/m2-publication-project.json", import.meta.url),
      "utf8",
    ),
  );
  const room = await readFile(new URL("../../../assets/delivery/test-room.glb", import.meta.url));
  const model = await readFile(new URL("../../../assets/delivery/test-crate.glb", import.meta.url));
  for (const scene of snapshot.scenes) {
    scene.environmentAssetId = environmentId;
    for (const object of scene.objects) {
      object.assetId = modelId;
    }
  }
  snapshot.scenes[0].environmentTransform = {
    position: [10, 0, 0],
    rotation: [0, 1, 0, 0],
    scale: [1, 1, 1],
  };
  const [exhibitX, , exhibitZ] = snapshot.scenes[0].objects[0].transform.position;
  snapshot.scenes[0].startCamera = {
    position: [exhibitX, 0.9, exhibitZ + 4],
    rotation: [0, 0, 0, 1],
    fovDegrees: 40,
  };
  snapshot.scenes[0].objects[1].visible = true;
  snapshot.scenes[0].rules[0].enabled = true;
  snapshot.scenes[0].rules[0].actions = [
    { type: "setVisible", objectId: snapshot.scenes[0].objects[1].id, visible: false },
  ];
  snapshot.scenes[1].environmentVisible = false;
  snapshot.scenes[1].objects[0].components.push({
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    type: "navigationPoint",
    label: "Return to entrance",
    sceneId: snapshot.scenes[1].id,
    viewpointId: snapshot.scenes[1].viewpoints[0].id,
  });
  const errors = [];
  const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  let release;
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let assetRequests = 0;
  let holdAssets = false;
  let releaseAssets;
  let assetGate;
  try {
    await checkFirstTouchAudio(browser, origin, publicationId);
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const routePublication = async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/manifest")) {
        await gate;
        return route.fulfill({
          json: {
            publicationId,
            projectId: snapshot.projectId,
            sourceRevision: 4,
            assets: [
              [environmentId, "environment", room],
              [modelId, "model", model],
            ].map(([id, kind, bytes]) => ({
              id,
              kind,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              url: `/api/v1/publications/${publicationId}/assets/${id}/bytes`,
            })),
          },
        });
      }
      if (path.endsWith("/bytes")) {
        assetRequests++;
        if (holdAssets) await assetGate;
        return route.fulfill({
          contentType: "model/gltf-binary",
          body: path.includes(environmentId) ? room : model,
        });
      }
      return route.fulfill({ json: snapshot });
    };
    await page.route("**/api/v1/publications/**", routePublication);

    // Observe the rendered scene and camera while keeping the real loader and controls
    const componentPath = new URL("../shared/player/ExhibitionCanvas.tsx", import.meta.url)
      .pathname;
    const component = await page.request.get(`${origin}/@fs${componentPath}`);
    assert.ok(component.ok());
    const componentText = await component.text();
    const threePath = componentText.match(/import \* as THREE from "([^"]+)"/)?.[1];
    const fpsPath = componentText.match(/import \{ FpsControls \} from "([^"]+)"/)?.[1];
    assert.ok(threePath);
    await page.goto(`${origin}/p/${publicationId}`);
    await page.addScriptTag({
      type: "module",
      content: `import * as THREE from ${JSON.stringify(threePath)};
    THREE.Scene.prototype.addEventListener("childadded", ({ target }) => {
      window.v2Scene = target;
    });
    const update = THREE.PerspectiveCamera.prototype.updateProjectionMatrix;
    THREE.PerspectiveCamera.prototype.updateProjectionMatrix = function () {
      window.v2Camera = this;
      return update.call(this);
    };
    window.v2Observed = true;`,
    });
    await page.waitForFunction(() => window.v2Observed);
    release();
    await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
    await page.waitForFunction(() => window.v2Scene?.children.some((node) => node.isGroup));
    const refusalPage = await browser.newPage();
    try {
      await refusalPage.route("**/api/v1/publications/**", routePublication);
      await refusalPage.route("**/visitor-without-lock.html", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<iframe title="Restricted exhibition" sandbox="allow-scripts allow-same-origin" src="/p/${publicationId}" style="width:100%;height:90vh;border:0"></iframe>`,
        }),
      );
      await refusalPage.goto(`${origin}/visitor-without-lock.html`);
      const embedded = refusalPage.frameLocator("iframe");
      await embedded.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
      const child = refusalPage
        .frames()
        .find((frame) => frame.url().endsWith(`/p/${publicationId}`));
      await child.evaluate(() => {
        window.refusal = { denied: false, clicks: 0 };
        document.addEventListener(
          "pointerlockerror",
          () => {
            window.refusal.denied = true;
          },
          { once: true },
        );
        document
          .querySelector("[data-exhibition-scene]")
          .addEventListener("exhibit-inspect", () => window.refusal.clicks++);
      });
      await embedded.locator("canvas").click();
      await child.waitForFunction(() => window.refusal.denied);
      assert.deepEqual(
        await child.evaluate(() => ({
          ...window.refusal,
          captured: !!document.pointerLockElement,
        })),
        { denied: true, clicks: 0, captured: false },
        "A denied capture press cannot activate the exhibit",
      );
      await embedded.locator("canvas").click();
      assert.equal(
        await child.evaluate(() => window.refusal.clicks),
        1,
        "Refusal enables ordinary raycast clicks",
      );
    } finally {
      await refusalPage.close();
    }

    await page.evaluate(() => {
      window.nativeInspectCount = 0;
      window.nativeInspect = () => window.nativeInspectCount++;
      document
        .querySelector("[data-exhibition-scene]")
        .addEventListener("exhibit-inspect", window.nativeInspect);
    });
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    assert.ok(box, "The exhibition canvas must be visible");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const inspections = () => page.evaluate(() => window.nativeInspectCount);
    await page.mouse.click(x, y);
    await page.waitForFunction(
      () => document.pointerLockElement === document.querySelector("canvas"),
    );
    assert.equal(await inspections(), 0, "Capture click does not activate");
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 4 });
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await inspections(), 0, "A locked drag out and back does not activate");
    await page.mouse.click(x, y);
    assert.equal(await inspections(), 1, "Native locked stationary click activates real geometry");
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const pointer = (type, init, target = canvas) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            ...init,
          }),
        );
      pointer("pointerdown");
      pointer("pointerup", { pointerId: 2 });
      pointer("pointerdown");
      pointer("pointercancel");
      pointer("pointerup");
      pointer("pointerdown", { isPrimary: false });
      pointer("pointerup", { isPrimary: false });
      pointer("pointerdown");
      pointer("pointerup", {}, document);
      pointer("pointerup");
      document.exitPointerLock();
    });
    assert.equal(await inspections(), 1, "Invalid pointer sequences cannot activate");
    await page.waitForFunction(() => !document.pointerLockElement);
    await page.keyboard.down("Alt");
    try {
      await page.mouse.click(x + 12, y);
    } finally {
      await page.keyboard.up("Alt");
    }
    assert.equal(await inspections(), 2, "Unlocked Alt click raycasts the exhibit");
    await page.evaluate(() => {
      const content = document.querySelector("[data-exhibition-scene]");
      content.removeEventListener("exhibit-inspect", window.nativeInspect);
      content.closest("details").open = false;
    });

    const first = snapshot.scenes[0];
    const roots = await page.evaluate(() =>
      window.v2Scene.children
        .filter((node) => node.isGroup)
        .map((node) => ({
          id: node.name,
          position: node.position.toArray(),
          rotation: node.quaternion.toArray(),
          scale: node.scale.toArray(),
          visible: node.visible,
        })),
    );
    assert.deepEqual(
      roots.find((node) => node.id === first.id).position,
      first.environmentTransform.position,
    );
    assert.deepEqual(
      roots.find((node) => node.id === first.id).rotation,
      first.environmentTransform.rotation,
    );
    for (const object of first.objects) {
      const actual = roots.find((node) => node.id === object.id);
      assert.deepEqual(actual.position, object.transform.position);
      assert.deepEqual(actual.scale, object.transform.scale);
      assert.equal(actual.visible, object === first.objects[1] ? false : object.visible);
    }
    await page.getByText("Exhibit information", { exact: true }).first().click();
    await page.getByRole("region", { name: "Exhibit information", exact: true }).waitFor();
    assert.ok((await page.locator("figure").innerText()).includes("Unicode 展览"));
    const bold = await page
      .locator("figure span")
      .first()
      .evaluate((node) => getComputedStyle(node).fontWeight);
    assert.ok(Number(bold) >= 600);

    // Saved navigation targets select the destination scene and viewpoint without editing the snapshot
    const navigation = first.objects[0].components.find((item) => item.type === "navigationPoint");
    await page.getByRole("button", { name: navigation.label, exact: true }).click();
    await page.waitForFunction(
      (id) => window.v2Scene?.children.some((node) => node.name === id),
      snapshot.scenes[1].id,
    );
    assert.equal(
      await page.locator("[data-exhibition-scene]").getAttribute("data-exhibition-scene"),
      snapshot.scenes[1].id,
    );
    assert.equal(
      await page.evaluate(
        (id) => window.v2Scene.getObjectByName(id).visible,
        snapshot.scenes[1].id,
      ),
      false,
    );
    const expected = snapshot.scenes[1].viewpoints.find(
      (view) => view.id === navigation.viewpointId,
    ).camera;
    const camera = await page.evaluate(() => window.v2Camera.position.toArray());
    camera.forEach((value, index) => assert.ok(Math.abs(value - expected.position[index]) < 0.001));
    // Each click must return to the saved view even when its scene and target have not changed
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.locator("canvas").focus();
      await page.keyboard.down("d");
      try {
        await page.waitForFunction(
          (position) =>
            window.v2Camera.position
              .toArray()
              .some((value, index) => Math.abs(value - position[index]) > 0.1),
          expected.position,
        );
      } finally {
        await page.keyboard.up("d");
      }
      await page.getByRole("button", { name: "Return to entrance", exact: true }).click();
      await page.waitForFunction(
        (position) =>
          window.v2Camera.position
            .toArray()
            .every((value, index) => Math.abs(value - position[index]) < 0.001),
        expected.position,
      );
      await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
    }

    // A navigation point runs its own click rules before falling back to its saved destination.
    const second = snapshot.scenes[1];
    const panel = first.objects[0].components.find((item) => item.type === "text");
    const pointRule = {
      id: "10000000-0000-4000-8000-000000000001",
      enabled: true,
      trigger: { type: "click", targetId: navigation.id.toUpperCase() },
      actions: [
        { type: "showPanel", panelId: panel.id },
        { type: "navigateScene", sceneId: first.id, viewpointId: first.viewpoints[0].id },
      ],
    };
    first.rules.push(pointRule);
    holdAssets = true;
    assetGate = new Promise((resolve) => {
      releaseAssets = resolve;
    });
    await page.reload();
    await page.locator(".visitor-information summary").click();
    const earlyPoint = page.getByRole("button", { name: navigation.label, exact: true });
    assert.equal(
      await earlyPoint.isDisabled(),
      true,
      "Navigation point must wait for playback listeners",
    );
    holdAssets = false;
    releaseAssets();
    await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.pointActions = 0;
      document
        .querySelector("[data-exhibition-scene]")
        .addEventListener("exhibit-show-panel", () => window.pointActions++);
    });
    const originalCanvas = await page.locator("canvas").elementHandle();
    await page.getByRole("button", { name: navigation.label, exact: true }).click();
    await page.waitForFunction((canvas) => !canvas.isConnected, originalCanvas);
    const pointResult = {
      actions: await page.evaluate(() => window.pointActions),
      destination: await page
        .locator("[data-exhibition-scene]")
        .getAttribute("data-exhibition-scene"),
    };
    first.rules.pop();

    // Scene-start navigation followed by an elapsed return used to mount A again.
    // Observe scene entry and a later action from B, whichever actually happens first.
    const returnDoor = {
      id: "10000000-0000-4000-8000-000000000002",
      type: "hotspot",
      label: "Go back deliberately",
    };
    const secondPanel = { ...panel, id: "10000000-0000-4000-8000-000000000003" };
    second.objects[0].components.push(returnDoor, secondPanel);
    first.rules[1].enabled = true;
    second.interactions = [
      {
        when: { type: "time-elapsed", seconds: 1 },
        do: { type: "navigate-scene", sceneId: first.id.toUpperCase() },
      },
      {
        when: { type: "time-elapsed", seconds: 1 },
        do: { type: "print-hi" },
      },
    ];
    second.rules = [
      {
        id: "10000000-0000-4000-8000-000000000004",
        enabled: true,
        trigger: { type: "elapsed", seconds: 1 },
        actions: [{ type: "showPanel", panelId: secondPanel.id }],
      },
      {
        id: "10000000-0000-4000-8000-000000000005",
        enabled: true,
        trigger: { type: "click", targetId: returnDoor.id },
        actions: [
          { type: "navigateScene", sceneId: first.id, viewpointId: first.viewpoints[0].id },
        ],
      },
    ];
    await page.addInitScript(() => {
      window.enteredScenes = [];
      new MutationObserver(() => {
        const id = document.querySelector("[data-exhibition-scene]")?.dataset.exhibitionScene;
        if (id && window.enteredScenes.at(-1) !== id) window.enteredScenes.push(id);
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-exhibition-scene"],
      });
    });
    const laterAction = page
      .waitForEvent("dialog", (dialog) => dialog.type() === "alert")
      .then(async (dialog) => {
        const message = dialog.message();
        await dialog.accept();
        return message;
      });
    const [, message] = await Promise.all([page.reload(), laterAction]);
    assert.equal(
      message,
      "hi",
      "The next legacy action runs after automatic navigation is rejected",
    );
    await page.waitForFunction(
      () =>
        window.enteredScenes.length >= 3 || document.querySelector(".visitor-information")?.open,
    );
    const automatic = await page.evaluate(() => window.enteredScenes.slice(0, 3));
    assert.deepEqual(
      { pointResult, automatic },
      {
        pointResult: { actions: 1, destination: first.id },
        automatic: [first.id, second.id],
      },
    );
    await page
      .getByRole("status")
      .getByText("Automatic scene navigation stopped at a repeated scene.", { exact: true })
      .waitFor();
    await page
      .locator(`[data-exhibition-scene="${second.id}"] [data-component-id="${secondPanel.id}"]`)
      .waitFor();
    await page.getByRole("button", { name: returnDoor.label, exact: true }).click();
    await page
      .getByRole("status")
      .getByText(/automatic scene navigation/i)
      .waitFor();
    assert.equal(
      await page.locator("[data-exhibition-scene]").getAttribute("data-exhibition-scene"),
      first.id,
    );

    // Entering a previous room by walking into its zone is a new interaction.
    // The incoming stationary camera starts outside the zone.
    const returnZone = {
      id: "10000000-0000-4000-8000-000000000006",
      name: "Return zone",
      transform: { position: [1.25, 1, 5], rotation: [0, 0, 0, 1], scale: [1, 4, 2] },
    };
    second.zones = [returnZone];
    second.interactions = [];
    second.rules = [
      {
        id: "10000000-0000-4000-8000-000000000007",
        enabled: true,
        trigger: { type: "zoneEnter", zoneId: returnZone.id },
        actions: [
          { type: "navigateScene", sceneId: first.id, viewpointId: first.viewpoints[0].id },
        ],
      },
    ];
    await page.reload();
    await page.waitForFunction(
      (id) => document.querySelector("[data-exhibition-scene]")?.dataset.exhibitionScene === id,
      second.id,
    );
    await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
    await page.locator("canvas").focus();
    await page.keyboard.down("d");
    try {
      await page.waitForFunction(() =>
        document
          .querySelector(".visitor-status")
          ?.textContent.includes("Automatic scene navigation"),
      );
    } finally {
      await page.keyboard.up("d");
    }
    assert.deepEqual(await page.evaluate(() => window.enteredScenes), [
      first.id,
      second.id,
      first.id,
    ]);
    // Explicit camera controls start a new chain before their destination enters a zone.
    second.viewpoints.push({
      id: "10000000-0000-4000-8000-000000000008",
      name: "Zone view",
      camera: { ...second.viewpoints[0].camera, position: [1.25, 1.6, 5] },
    });
    second.objects[0].components.push({
      id: "10000000-0000-4000-8000-000000000009",
      type: "navigationPoint",
      label: "Zone view",
      sceneId: second.id,
      viewpointId: second.viewpoints.at(-1).id,
    });
    await page.reload();
    await page.waitForFunction(
      (id) => document.querySelector("[data-exhibition-scene]")?.dataset.exhibitionScene === id,
      second.id,
    );
    await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
    if (!(await page.locator(".visitor-information").evaluate((node) => node.open)))
      await page.locator(".visitor-information summary").click();
    await page.getByRole("button", { name: "Zone view", exact: true }).click();
    await page.waitForFunction(
      (id) => window.enteredScenes.includes(id) && window.enteredScenes.length >= 3,
      first.id,
    );
    assert.deepEqual((await page.evaluate(() => window.enteredScenes)).slice(0, 3), [
      first.id,
      second.id,
      first.id,
    ]);

    returnZone.transform.position = [0, 1.6, 5];
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.reload();
    await page.addScriptTag({
      type: "module",
      content: `import * as THREE from ${JSON.stringify(threePath)};
      import { FpsControls } from ${JSON.stringify(fpsPath)};
      const sync = FpsControls.prototype.syncFromCamera;
      FpsControls.prototype.syncFromCamera = function () { window.v2Fps = this; return sync.call(this); };
      const update = THREE.PerspectiveCamera.prototype.updateProjectionMatrix;
      THREE.PerspectiveCamera.prototype.updateProjectionMatrix = function () { window.v2Camera = this; return update.call(this); };`,
    });
    release();
    await page
      .getByRole("status")
      .getByText(/automatic scene navigation/i)
      .waitFor();
    await page.evaluate(async () => {
      window.v2Camera.position.set(10, 1.6, 5);
      window.v2Fps.syncFromCamera();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    if (!(await page.locator(".visitor-information").evaluate((node) => node.open)))
      await page.locator(".visitor-information summary").click();
    await page.getByRole("button", { name: "Return to entrance", exact: true }).click();
    await page.waitForFunction(() => window.enteredScenes.length >= 3, null, { timeout: 5000 });
    assert.deepEqual((await page.evaluate(() => window.enteredScenes)).slice(0, 3), [
      first.id,
      second.id,
      first.id,
    ]);
    second.objects[0].components.pop();
    second.viewpoints.pop();
    first.rules[1].enabled = false;

    // Supported rules load normally; external legacy audio still fails before fetching assets
    snapshot.scenes[0].rules[0].enabled = true;
    gate = Promise.resolve();
    await page.reload();
    await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
    assert.equal(await page.locator("canvas").count(), 1);
    snapshot.scenes[0].interactions = [
      {
        when: { type: "scene-starts" },
        do: { type: "play-audio", url: "https://example.com/track.m4a" },
      },
    ];
    assetRequests = 0;
    gate = Promise.resolve();
    await page.reload();
    await page
      .getByRole("alert")
      .filter({ hasText: "This exhibition audio must use an approved library track." })
      .waitFor();
    assert.equal(assetRequests, 0);
    assert.equal(await page.locator("canvas").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "V2 visitor passed: transforms, visibility, text, captions, navigation, supported rules and external audio rejection",
    );
  } finally {
    await browser.close();
  }

  await checkPlayback();
}

// Reuse production playback/content with real local media and an isolated loopback test server
async function checkFirstTouchAudio(browser, origin, publicationId) {
  const page = await browser.newPage({
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const project = structuredClone(blankProject);
    const assetId = "22222222-2222-4222-8222-222222222222";
    const audio = await readFile(
      new URL("../../../assets/delivery/audio/calm-piano.m4a", import.meta.url),
    );
    const base = `/api/v1/publications/${publicationId}`;
    const url = `${base}/assets/${assetId}/bytes`;
    project.scenes[0].audio = [
      {
        id: "63636363-6363-4363-8363-636363636363",
        type: "audio",
        mode: "global",
        assetId,
        caption: "Background music",
        loop: true,
        volume: 0.6,
      },
    ];
    await page.route(`**${base}**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === url) return route.fulfill({ contentType: "audio/mp4", body: audio });
      if (path === base) return route.fulfill({ json: project });
      return route.fulfill({
        json: {
          publicationId,
          projectId: project.projectId,
          sourceRevision: 1,
          assets: [
            {
              id: assetId,
              kind: "audio",
              sha256: createHash("sha256").update(audio).digest("hex"),
              url,
            },
          ],
        },
      });
    });
    // Observe the native autoplay decision without evaluating in the page before the first tap.
    // Browser automation can otherwise grant user activation during the setup.
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        const attempt = play.call(this);
        attempt.then(
          () => console.log("Initial audio playing"),
          (error) => console.log("Initial audio", error.name),
        );
        return attempt;
      };
    });
    const outcome = page.waitForEvent("console", (message) =>
      message.text().startsWith("Initial audio"),
    );
    await page.goto(`${origin}/p/${publicationId}`);
    assert.equal((await outcome).text(), "Initial audio NotAllowedError");
    // Blank canvas above the centered audio notice and the movement controls.
    await page.touchscreen.tap(195, 220);
    await page.waitForFunction(
      () => {
        const track = document.querySelector("audio[data-background]");
        return track && !track.paused && track.currentTime > 0;
      },
      undefined,
      { timeout: 5000 },
    );
    console.log("First touch on empty visitor canvas starts blocked background music.");
  } finally {
    await page.close();
  }
}

async function checkPlayback() {
  const dir = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(path.join(dir, "test-results/visitor-playback-probe"), { recursive: true });
  const fixtureSource = `import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as THREE from "three";
import { createVisitorPlayback } from "/shared/player/playback";
import { ExhibitionContent } from "/shared/player/ExhibitionContent";
import "/shared/player/player.css";
const data = await (await fetch("/fixture-data")).json();
const pose={position:[0,0,5],rotation:[0,0,0,1],fovDegrees:60};
const transform={position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]};
const audio=(id,mode="global")=>({id,type:"audio",assetId:"audio",caption:id,mode,loop:true,volume:0.4});
const text={id:"panel",type:"text",runs:[{text:"Verified visitor content",marks:["bold"]}],caption:"Panel"};
const image={id:"image",type:"image",assetId:"image",caption:"Image",alt:"Real local image"};
const video={id:"video",type:"video",assetId:"video",caption:"Real local video",loop:true,volume:0.3};
const rule=(id,trigger,actions)=>({id,enabled:true,trigger,actions});
const scene={id:"scene",name:"Probe",startCamera:pose,audio:[audio("bg")],objects:[
 {id:"owner",name:"Main exhibit",transform,visible:true,components:[audio("spatial","spatial"),text,image,video,{id:"hotspot",type:"hotspot",label:"Activate hotspot"}]},
 {id:"other",name:"Other exhibit",transform,visible:true,components:[{...text,id:"other-panel"}]},
 {id:"hidden",name:"Hidden exhibit",transform,visible:false,components:[audio("hidden-audio","spatial")]},
 {id:"navigation",name:"Navigation",transform,visible:true,components:[{id:"go",type:"hotspot",label:"Navigate by rule"},{id:"navpoint",type:"navigationPoint",label:"Navigation point",sceneId:"next",viewpointId:"next-view"}]}
,
 {id:"move",name:"Camera",transform,visible:true,components:[{id:"move-hot",type:"hotspot",label:"Move camera"}]},
 {id:"link",name:"Link",transform,visible:true,components:[{id:"link-hot",type:"hotspot",label:"Open link"}]},
 {id:"display",name:"Digital display",transform,visible:true,assetId:"image",components:[{...image,id:"display-image"}]}
],hotspots:[{id:"scene-hotspot",objectId:"other",label:"Scene hotspot"}],viewpoints:[{id:"view",name:"View",camera:{...pose,position:[2,3,4],fovDegrees:75}}],zones:[{id:"zone",transform:{...transform,scale:[2,2,2]}}],rules:[
 rule("gaze",{type:"gaze",targetId:"hotspot",seconds:1},[{type:"showPanel",panelId:"panel"}]),
 rule("scene-gaze",{type:"gaze",targetId:"SCENE-HOTSPOT",seconds:1},[{type:"showPanel",panelId:"other-panel"}]),
 rule("zone",{type:"zoneEnter",zoneId:"zone"},[{type:"showPanel",panelId:"image"}]),
 rule("move",{type:"click",targetId:"move-hot"},[{type:"moveCamera",viewpointId:"view",durationSeconds:2}]),
 rule("link",{type:"click",targetId:"link-hot"},[{type:"openLink",url:"https://example.com/exhibition"}]),
 rule("start",{type:"sceneStart"},[{type:"setVisible",objectId:"other",visible:false},{type:"showPanel",panelId:"panel"}]),
 rule("elapsed",{type:"elapsed",seconds:0.25},[{type:"showPanel",panelId:"image"}]),
 rule("click",{type:"click",targetId:"hotspot"},[{type:"playMedia",mediaId:"video"},{type:"setVisible",objectId:"other",visible:true}]),
 rule("close",{type:"panelClose",panelId:"panel"},[{type:"setVisible",objectId:"other",visible:false}]),
 rule("navigate",{type:"click",targetId:"go"},[{type:"navigateScene",sceneId:"next",viewpointId:"next-view"}])
]};
const original=JSON.stringify(scene), calls=[], reports=[], links=[];
const originalClick=HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click=function(){links.push({href:this.href,target:this.target,rel:this.rel})};
const camera=new THREE.PerspectiveCamera();camera.position.set(0,0,5);
const controls={target:new THREE.Vector3(),update(){}};
const roots=new Map(scene.objects.map(o=>{const root=new THREE.Group();root.visible=o.visible;return[o.id,root]}));
const root=createRoot(document.getElementById("root"));
const navigate=(scene,view)=>{calls.push([scene,view]);return true;};
(window as any).modalEvents=[];document.addEventListener("exhibit-modal",e=>(window as any).modalEvents.push(e.detail));
flushSync(()=>root.render(<><button id="start">Start exhibition</button><ExhibitionContent scene={scene as any} assets={data.assets} navigate={navigate} playbackReady={true}/></>));
const content=document.querySelector('[data-exhibition-scene]');
const runtime=createVisitorPlayback(scene as any,camera,controls,roots,content,navigate,message=>reports.push(message),()=>{});
document.querySelector('#start').addEventListener('click',()=>runtime.start());
content.querySelector('[data-component-id="panel"]').hidden=true;
content.querySelector('[data-component-id="image"]').hidden=true;
const revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);revoke(url)};
(window as any).probe={runtime,scene,camera,roots,calls,reports,links,controls,original,revoked,unmount:()=>{root.unmount();HTMLAnchorElement.prototype.click=originalClick},
 sound:()=>roots.get("owner").children.find(n=>n.type==="Audio"),
 restart:()=>createVisitorPlayback(scene as any,camera,controls,roots,content,navigate,message=>reports.push(message),()=>{}),
 hiddenPlay(){scene.rules.find(r=>r.id==="click").actions.splice(0,2,{type:"setVisible",objectId:"owner",visible:false},{type:"playMedia",mediaId:"spatial"});runtime.click("owner")},
};
document.dispatchEvent(new Event("visitor-playback-ready"));
`;
  const media = {
    audio: ["../../assets/delivery/audio/calm-piano.m4a", "audio/mp4"],
    image: ["../../assets/delivery/thumbnails/test-crate.png", "image/png"],
    video: ["../../assets/delivery/sample-media/sample-sunset-motion.webm", "video/webm"],
  };
  const assets = Object.entries(media).map(([id, [file, mime]]) => ({
    id,
    name: id,
    kind: id,
    url: `/fixture-media/${id}`,
    sha256: createHash("sha256")
      .update(readFileSync(path.resolve(dir, file)))
      .digest("hex"),
    thumbnail: null,
    ...(id === "image" ? { displayRole: "digital" } : {}),
  }));
  let audioGate;
  const server = await createServer({
    configFile: false,
    root: dir,
    cacheDir: path.join(dir, "test-results/vite-visitor-playback"),
    // Virtual fixtures bypass HTML scanning; prebundle their CommonJS imports together before serving
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "react",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-dom",
        "react-dom/client",
        "three",
      ],
    },
    logLevel: "silent",
    plugins: [
      react(),
      {
        name: "isolated-media",
        resolveId(id) {
          if (id === "/__visitor-playback-fixture.tsx")
            return "virtual:visitor-playback-fixture.tsx";
        },
        load(id) {
          if (id === "virtual:visitor-playback-fixture.tsx") return fixtureSource;
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.startsWith("/__native-media?")) {
              res.setHeader("Content-Type", "text/html");
              res.end(
                '<!doctype html><html><body><button id="activate">Enable audio</button><script type="module" src="/tests/native-media-fixture.mjs"></script></body></html>',
              );
              return;
            }
            if (req.url === "/__visitor-playback") {
              res.setHeader("Content-Type", "text/html");
              res.end(
                await server.transformIndexHtml(
                  req.url,
                  '<!doctype html><html><body><div id="root"></div><script type="module" src="/__visitor-playback-fixture.tsx"></script></body></html>',
                ),
              );
              return;
            }
            if (req.url === "/fixture-data") {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ assets }));
              return;
            }
            const id = req.url?.replace("/fixture-media/", "");
            if (media[id]) {
              if (id === "audio" && audioGate) {
                await audioGate;
                if (res.destroyed) return;
              }
              res.setHeader("Content-Type", media[id][1]);
              res.end(readFileSync(path.resolve(dir, media[id][0])));
              return;
            }
            next();
          });
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      fs: { allow: [path.resolve(dir, "../..")] },
    },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  let browser;
  try {
    browser = await launchBrowser({ target: origin });
    await checkNativeMedia(browser, origin);
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/__visitor-playback");
    await page
      .waitForFunction(
        () =>
          window.probe &&
          document.querySelectorAll('audio[src^="blob:"]').length === 3 &&
          document.querySelector("video")?.readyState >= 2 &&
          document.querySelector("img")?.naturalWidth > 0,
      )
      .catch(async (cause) => {
        throw new Error(
          JSON.stringify({
            errors,
            media: await page.evaluate(() =>
              [...document.querySelectorAll("audio,video,img")].map((node) => ({
                tag: node.tagName,
                src: node.src,
                ready: node.readyState,
                width: node.naturalWidth,
                error: node.error?.message,
              })),
            ),
          }),
          { cause },
        );
      });
    await page.evaluate(() => probe.runtime.begin());
    assert.equal(await page.evaluate(() => probe.roots.get("other").visible), false);
    assert.equal(
      await page.locator('[data-component-id="panel"]').evaluate((node) => node.hidden),
      false,
    );
    await page.locator('[data-component-id="panel"]').evaluate((node) => {
      node.hidden = true;
    });
    await page.locator("#start").click();
    await page.waitForFunction(
      () => document.querySelector('[data-component-id="spatial"] audio').currentTime > 0,
    );
    assert.equal(
      await page.locator('[data-component-id="panel"]').evaluate((node) => node.hidden),
      true,
      "Audio unlock does not repeat sceneStart",
    );
    await page.locator('[data-component-id="panel"]').evaluate((node) => {
      node.hidden = false;
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("audio")]
        .filter((a) => !a.closest("[hidden]"))
        .every((a) => !a.paused && a.currentTime > 0),
    );
    await page.evaluate(() => {
      const sound = probe.sound();
      probe.analyser = sound.context.createAnalyser();
      sound.panner.connect(probe.analyser);
    });
    await page.waitForFunction(() => {
      const samples = new Float32Array(probe.analyser.fftSize);
      probe.analyser.getFloatTimeDomainData(samples);
      return samples.some((value) => Math.abs(value) > 0.00001);
    });
    await page.evaluate(() => {
      probe.sound().panner.disconnect(probe.analyser);
      probe.analyser.disconnect();
    });
    const initial = await page.evaluate(() => ({
      context: probe.camera.children.find((n) => n.type === "AudioListener")?.context.state,
      panner: probe.sound()?.panner instanceof PannerNode,
      panning: probe.sound()?.panner.panningModel,
      other: probe.roots.get("other").visible,
      panel: document.querySelector('[data-component-id="panel"]').hidden,
      hiddenPaused: document.querySelector('[aria-label="hidden-audio"]').paused,
      volumes: [...document.querySelectorAll("audio")].map((a) => a.volume),
    }));
    assert.deepEqual(initial, {
      context: "running",
      panner: true,
      panning: "HRTF",
      other: false,
      panel: false,
      hiddenPaused: true,
      volumes: [0.4, 0.4, 0.4],
    });
    await page.evaluate(() => probe.runtime.update(0.3));
    assert.equal(
      await page.locator('[data-component-id="image"]').evaluate((n) => n.hidden),
      false,
    );
    // A later interaction must preserve the visitor's manual pause
    await page.evaluate(() => document.querySelector("audio").pause());
    await page.getByRole("button", { name: "Activate hotspot", exact: true }).click();
    assert.equal(
      await page
        .locator("audio")
        .first()
        .evaluate((node) => node.paused),
      true,
    );
    await page.waitForFunction(
      () =>
        !document.querySelector("video").paused && document.querySelector("video").currentTime > 0,
    );
    assert.equal(await page.evaluate(() => probe.roots.get("other").visible), true);
    await page
      .locator('[data-component-id="panel"]')
      .getByRole("button", { name: "Close panel" })
      .click();
    assert.equal(await page.evaluate(() => probe.roots.get("other").visible), false);
    assert.equal(await page.locator('[data-component-id="panel"]').evaluate((n) => n.hidden), true);
    // Clicking a digital display opens a modal with the verified media centered
    await page.evaluate(() =>
      document
        .querySelector("[data-exhibition-scene]")
        .dispatchEvent(new CustomEvent("exhibit-inspect", { detail: "display" })),
    );
    const displayModal = page.locator(".visitor-media-dialog");
    await displayModal.waitFor({ state: "visible" });
    assert.equal(await displayModal.evaluate((node) => node.matches(":modal")), true);
    assert.equal(await page.locator(".visitor-information").isVisible(), false);
    assert.equal(await page.evaluate(() => window.modalEvents.at(-1)), true);
    await displayModal.locator("img").waitFor();
    const centering = await displayModal.evaluate((node) => {
      const imageBox = node.querySelector("img").getBoundingClientRect();
      const dialogBox = node.getBoundingClientRect();
      return {
        image: [imageBox.left, imageBox.right],
        dialog: [dialogBox.left, dialogBox.right],
        delta: Math.abs(imageBox.left + imageBox.right - dialogBox.left - dialogBox.right),
      };
    });
    assert.equal(
      centering.delta < 2,
      true,
      `Display media is centered: ${JSON.stringify(centering)}`,
    );
    await page.mouse.click(5, 5);
    await displayModal.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".visitor-information").isVisible(), true);
    assert.equal(await page.evaluate(() => window.modalEvents.at(-1)), false);
    // Gaze requires a continuous dwell and resets when the visitor looks away
    await page.evaluate(() => probe.runtime.update(0.5, "owner"));
    assert.equal(await page.locator('[data-component-id="panel"]').evaluate((n) => n.hidden), true);
    await page.evaluate(() => probe.runtime.update(0.6, "owner"));
    assert.equal(
      await page.locator('[data-component-id="panel"]').evaluate((n) => n.hidden),
      false,
    );
    await page
      .locator('[data-component-id="panel"]')
      .getByRole("button", { name: "Close panel" })
      .click();
    await page.evaluate(() => {
      probe.runtime.update(0.1);
      probe.runtime.update(0.6, "owner");
    });
    assert.equal(await page.locator('[data-component-id="panel"]').evaluate((n) => n.hidden), true);
    await page.evaluate(() => probe.runtime.update(0.5, "owner"));
    assert.equal(
      await page.locator('[data-component-id="panel"]').evaluate((n) => n.hidden),
      false,
    );
    // Scene hotspots resolve their owning model and share the same continuous dwell behavior
    await page.evaluate(() => {
      document.querySelector('[data-component-id="other-panel"]').hidden = true;
      probe.runtime.update(0.6, "other");
      probe.runtime.update(0.1, "owner");
      probe.runtime.update(0.6, "other");
    });
    assert.equal(
      await page.locator('[data-component-id="other-panel"]').evaluate((n) => n.hidden),
      true,
    );
    await page.evaluate(() => probe.runtime.update(0.5, "OTHER"));
    assert.equal(
      await page.locator('[data-component-id="other-panel"]').evaluate((n) => n.hidden),
      false,
    );
    // Zone entry fires once until the camera leaves and enters again
    await page
      .locator('[data-component-id="image"]')
      .getByRole("button", { name: "Close panel" })
      .click();
    await page.evaluate(() => {
      probe.camera.position.set(0, 0, 0);
      probe.runtime.update(0.01);
    });
    assert.equal(
      await page.locator('[data-component-id="image"]').evaluate((n) => n.hidden),
      false,
    );
    await page
      .locator('[data-component-id="image"]')
      .getByRole("button", { name: "Close panel" })
      .click();
    await page.evaluate(() => probe.runtime.update(0.01));
    assert.equal(await page.locator('[data-component-id="image"]').evaluate((n) => n.hidden), true);
    await page.evaluate(() => {
      probe.camera.position.set(0, 0, 5);
      probe.runtime.update(0.01);
      probe.camera.position.set(0, 0, 0);
      probe.runtime.update(0.01);
    });
    assert.equal(
      await page.locator('[data-component-id="image"]').evaluate((n) => n.hidden),
      false,
    );
    // Camera transitions interpolate and settle on the authored pose and field of view
    await page.evaluate(() => probe.camera.position.set(0, 0, 5));
    await page.getByRole("button", { name: "Move camera", exact: true }).click();
    await page.evaluate(() => probe.runtime.update(1));
    assert.deepEqual(await page.evaluate(() => probe.camera.position.toArray()), [1, 1.5, 4.5]);
    await page.evaluate(() => probe.runtime.update(1));
    assert.deepEqual(
      await page.evaluate(() => ({
        position: probe.camera.position.toArray(),
        rotation: probe.camera.quaternion.toArray(),
        fov: probe.camera.fov,
      })),
      { position: [2, 3, 4], rotation: [0, 0, 0, 1], fov: 75 },
    );
    // Observe the link contract without navigating beyond the loopback fixture
    await page.getByRole("button", { name: "Open link", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => probe.links), [
      { href: "https://example.com/exhibition", target: "_blank", rel: "noopener noreferrer" },
    ]);
    assert.equal(
      await page.evaluate(() => JSON.stringify(probe.scene) === probe.original),
      true,
      "Runtime must not mutate authored content",
    );
    await page.screenshot({
      path: "test-results/visitor-playback-probe/playing.png",
      fullPage: true,
    });
    // Hide through the real rule executor and verify both the visible root and media pause together
    await page.evaluate(() => {
      probe.scene.rules
        .find((r) => r.id === "click")
        .actions.splice(0, 2, { type: "setVisible", objectId: "owner", visible: false });
      probe.runtime.click("owner");
    });
    assert.equal(await page.evaluate(() => probe.roots.get("owner").visible), false);
    assert.equal(await page.locator('[aria-label="spatial"]').evaluate((n) => n.paused), true);
    assert.equal(await page.locator("video").evaluate((n) => n.paused), true);
    await page.getByRole("button", { name: "Navigation point", exact: true }).click();
    await page.getByRole("button", { name: "Navigate by rule", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => probe.calls), [
      ["next", "next-view"],
      ["next", "next-view"],
    ]);
    await page.screenshot({
      path: "test-results/visitor-playback-probe/verified.png",
      fullPage: true,
    });
    const cleanup = await page.evaluate(() => {
      probe.runtime.dispose();
      return {
        paused: [...document.querySelectorAll("audio,video")].every((n) => n.paused),
        listeners: probe.camera.children.filter((n) => n.type === "AudioListener").length,
        sounds: [...probe.roots.values()]
          .flatMap((n) => n.children)
          .filter((n) => n.type === "Audio").length,
      };
    });
    assert.deepEqual(cleanup, { paused: true, listeners: 0, sounds: 0 });
    const restart = await page.evaluate(() => {
      const next = probe.restart();
      try {
        next.start();
        return { ok: true };
      } catch (error) {
        return { ok: false, name: error.name, message: error.message };
      } finally {
        next.dispose();
      }
    });
    assert.deepEqual(
      restart,
      { ok: true },
      "Playback can reconnect the same media elements after navigation",
    );
    const count = await page.evaluate(() => document.querySelectorAll('[src^="blob:"]').length);
    await page.evaluate(() => probe.unmount());
    // The display modal verified its own copy of the image and revoked it when closed
    await page.waitForFunction((count) => probe.revoked.length === count + 1, count);
    assert.deepEqual(errors, []);
    // A hidden owner must remain silent even if a following action targets its media
    await page.reload();
    await page.waitForFunction(
      () =>
        window.probe &&
        document.querySelectorAll('audio[src^="blob:"]').length === 3 &&
        document.querySelector("video")?.readyState >= 2,
    );
    await page.locator("#start").click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="spatial"]').paused);
    await page.evaluate(() => {
      probe.scene.rules
        .find((r) => r.id === "click")
        .actions.splice(
          0,
          2,
          { type: "setVisible", objectId: "owner", visible: false },
          { type: "playMedia", mediaId: "spatial" },
        );
      probe.runtime.click("owner");
    });
    const hiddenOwner = await page.evaluate(() => ({
      hidden: document.querySelector('[data-owner-id="owner"]').hidden,
      paused: document.querySelector('[aria-label="spatial"]').paused,
    }));
    assert.deepEqual(
      hiddenOwner,
      { hidden: true, paused: true },
      "A hidden owner stays silent after playMedia",
    );
    await page.evaluate(() => {
      probe.runtime.dispose();
      probe.unmount();
    });
    // Start before verified audio arrives, including owners hidden or disposed while waiting
    for (const state of [
      "playing",
      "hidden",
      "disposed",
      "backgrounded",
      "backgrounded-hidden",
      "backgrounded-ready",
    ]) {
      const gate = Promise.withResolvers();
      audioGate = gate.promise;
      let phase = "opening";
      try {
        await withVisibilityPage(page, async (target) => {
          await target.setVisible(true);
          await target.goto(origin + "/__visitor-playback");
          phase = "waiting for the runtime";
          await target.evaluate(() => {
            if (window.probe) return;
            return new Promise((resolve) => {
              document.addEventListener("visitor-playback-ready", () => resolve(), { once: true });
            });
          });
          const hideOwner = state === "hidden" || state === "backgrounded-hidden";
          const disposed = state === "disposed";
          const startWhileHidden = state === "backgrounded-ready";
          const expectedPlaying = disposed ? [] : hideOwner ? ["bg"] : ["bg", "spatial"];
          const setup = await target.evaluate(
            ({ hideOwner, disposed, startWhileHidden, expectedPlaying }) => {
              const nodes = [...document.querySelectorAll("audio")];
              const hiddenPlayAttempts = [];
              for (const node of nodes) {
                const play = node.play.bind(node);
                node.play = () => {
                  if (document.hidden) hiddenPlayAttempts.push(node.getAttribute("aria-label"));
                  return play();
                };
              }
              const waitForMedia = (node, event, ready) =>
                new Promise((resolve, reject) => {
                  const listeners = new AbortController();
                  const check = () => {
                    if (!ready()) return;
                    listeners.abort();
                    resolve();
                  };
                  node.addEventListener(event, check, { signal: listeners.signal });
                  node.addEventListener(
                    "error",
                    () => {
                      listeners.abort();
                      reject(new Error(node.error?.message ?? "Audio did not load"));
                    },
                    { signal: listeners.signal },
                  );
                  check();
                });
              const loaded = Promise.all(
                nodes.map((node) => waitForMedia(node, "loadeddata", () => node.readyState >= 2)),
              );
              const sources = new Promise((resolve) => {
                const check = () => {
                  if (!nodes.every((node) => node.src.startsWith("blob:"))) return;
                  observer.disconnect();
                  resolve();
                };
                const observer = new MutationObserver(check);
                for (const node of nodes) observer.observe(node, { attributeFilter: ["src"] });
                check();
              });
              const playing = Promise.all(
                nodes
                  .filter((node) => expectedPlaying.includes(node.getAttribute("aria-label")))
                  .map((node) =>
                    waitForMedia(node, "timeupdate", () => !node.paused && node.currentTime > 0),
                  ),
              );
              window.delayedAudio = { loaded, playing, sources, hiddenPlayAttempts };
              if (!startWhileHidden) document.querySelector("#start").click();
              if (hideOwner) probe.hiddenPlay();
              if (disposed) probe.runtime.dispose();
              return {
                visible: !document.hidden,
                tracks: nodes.length,
                available: nodes.filter((node) => node.hasAttribute("src")).length,
              };
            },
            { hideOwner, disposed, startWhileHidden, expectedPlaying },
            { userGesture: true },
          );
          assert.deepEqual(setup, { visible: true, tracks: 3, available: 0 });
          const backgrounded = state.startsWith("backgrounded");
          if (backgrounded && !startWhileHidden) await target.setVisible(false);
          phase = "waiting for verified media sources";
          gate.resolve();
          await target.evaluate(async () => {
            await window.delayedAudio.sources;
          });
          if (startWhileHidden) {
            phase = "decoding audio before backgrounding";
            await target.evaluate(async () => {
              await window.delayedAudio.loaded;
            });
            await target.setVisible(false);
            await target.evaluate(() => document.querySelector("#start").click(), undefined, {
              userGesture: true,
            });
          }
          if (backgrounded) {
            assert.deepEqual(
              await target.evaluate(() => ({
                hidden: document.hidden,
                playing: [...document.querySelectorAll("audio")].some((node) => !node.paused),
                hiddenPlayAttempts: window.delayedAudio.hiddenPlayAttempts,
              })),
              { hidden: true, playing: false, hiddenPlayAttempts: [] },
            );
            if (startWhileHidden) {
              assert.equal(
                await target.evaluate(() =>
                  [...document.querySelectorAll("audio")].every((node) => node.readyState >= 2),
                ),
                true,
              );
            }
            await target.setVisible(true);
          }
          phase = "waiting for audio to decode";
          await target.evaluate(async () => {
            await window.delayedAudio.loaded;
          });
          phase = "waiting for playback";
          await target.evaluate(async () => {
            await window.delayedAudio.playing;
          });
          assert.deepEqual(
            await target.evaluate(() =>
              [...document.querySelectorAll("audio")]
                .filter((node) => !node.paused)
                .map((node) => node.getAttribute("aria-label")),
            ),
            expectedPlaying,
            state,
          );
          if (state === "backgrounded-ready") {
            phase = "pausing active spatial audio in the background";
            await target.evaluate(() => {
              const audio = document.querySelector('audio[aria-label="spatial"]');
              const paused = new Promise((resolve) => {
                audio.addEventListener("pause", () => resolve(), { once: true });
              });
              window.spatialVisibility = { audio, paused };
            });
            await target.setVisible(false);
            assert.deepEqual(
              await target.evaluate(async () => {
                const { audio, paused } = window.spatialVisibility;
                await paused;
                window.spatialVisibility.resumed = new Promise((resolve) => {
                  audio.addEventListener("playing", () => resolve(), { once: true });
                });
                return { hidden: document.hidden, paused: audio.paused };
              }),
              { hidden: true, paused: true },
            );
            phase = "resuming active spatial audio in the foreground";
            await target.setVisible(true);
            assert.deepEqual(
              await target.evaluate(async () => {
                const { audio, resumed } = window.spatialVisibility;
                await resumed;
                return { hidden: document.hidden, paused: audio.paused };
              }),
              { hidden: false, paused: false },
            );
          }
          await target.evaluate((disposed) => {
            if (!disposed) probe.runtime.dispose();
            probe.unmount();
          }, disposed);
        });
      } catch (error) {
        throw new Error(`Delayed audio (${state}) failed while ${phase}`, { cause: error });
      } finally {
        audioGate = undefined;
        gate.resolve();
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS real M4A/video playback, native image, HRTF panner, sceneStart/elapsed/click/gaze/zone/camera/link/panelClose/setVisible/navigation, delayed audio, disconnect and Blob URL cleanup",
    );
  } finally {
    await browser?.close();
    await server.close();
  }
}
