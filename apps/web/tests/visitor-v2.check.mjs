import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "./browser-security.mjs";

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
  snapshot.scenes[0].objects[1].visible = false;
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
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/v1/publications/**", async (route) => {
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
        return route.fulfill({
          contentType: "model/gltf-binary",
          body: path.includes(environmentId) ? room : model,
        });
      }
      return route.fulfill({ json: snapshot });
    });

    // Observe the rendered scene and camera while keeping the real loader and controls
    const componentPath = new URL("../visitor/ExhibitionCanvas.tsx", import.meta.url).pathname;
    const component = await page.request.get(`${origin}/@fs${componentPath}`);
    assert.ok(component.ok());
    const threePath = (await component.text()).match(/import \* as THREE from "([^"]+)"/)?.[1];
    assert.ok(threePath);
    await page.goto(`${origin}/p/${publicationId}`);
    await page.addScriptTag({
      type: "module",
      content: `import * as THREE from ${JSON.stringify(threePath)};
    const add = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function (...objects) {
      if (this.isScene) { window.v2Scene = this; }
      return add.apply(this, objects);
    };
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
      assert.equal(actual.visible, object.visible);
    }
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
    assert.equal(await page.getByRole("combobox").inputValue(), "1");
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
      await page.locator("canvas").press("ArrowRight");
      assert.notDeepEqual(
        await page.evaluate(() => window.v2Camera.position.toArray()),
        expected.position,
      );
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
async function checkPlayback() {
  const dir = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(path.join(dir, "test-results/visitor-playback-probe"), { recursive: true });
  const fixtureSource = `import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as THREE from "three";
import { createVisitorPlayback } from "/visitor/visitor-playback";
import { ExhibitionContent } from "/visitor/ExhibitionContent";
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
 {id:"link",name:"Link",transform,visible:true,components:[{id:"link-hot",type:"hotspot",label:"Open link"}]}
],viewpoints:[{id:"view",name:"View",camera:{...pose,position:[2,3,4],fovDegrees:75}}],zones:[{id:"zone",transform:{...transform,scale:[2,2,2]}}],rules:[
 rule("gaze",{type:"gaze",targetId:"hotspot",seconds:1},[{type:"showPanel",panelId:"panel"}]),
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
const navigate=(...args)=>calls.push(args);
flushSync(()=>root.render(<><button id="start">Start exhibition</button><ExhibitionContent scene={scene as any} assets={data.assets} navigate={navigate}/></>));
await new Promise(resolve=>requestAnimationFrame(resolve));
const content=document.querySelector('[data-exhibition-scene]');
const runtime=createVisitorPlayback(scene as any,camera,controls,roots,content,navigate,message=>reports.push(message));
document.querySelector('#start').addEventListener('click',()=>runtime.start());
content.querySelector('[data-component-id="panel"]').hidden=true;
content.querySelector('[data-component-id="image"]').hidden=true;
const revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);revoke(url)};
(window as any).probe={runtime,scene,camera,roots,calls,reports,links,controls,original,revoked,unmount:()=>{root.unmount();HTMLAnchorElement.prototype.click=originalClick},
 sound:()=>roots.get("owner").children.find(n=>n.type==="Audio"),
 restart:()=>createVisitorPlayback(scene as any,camera,controls,roots,content,navigate,message=>reports.push(message)),
 hiddenPlay(){scene.rules.find(r=>r.id==="click").actions.splice(0,2,{type:"setVisible",objectId:"owner",visible:false},{type:"playMedia",mediaId:"spatial"});runtime.click("owner")},
};
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
  }));
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
    await page.locator("#start").click();
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
    await page.waitForFunction((count) => probe.revoked.length === count, count);
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
    for (const state of ["playing", "hidden", "disposed"]) {
      let releaseAudio;
      const audioGate = new Promise((resolve) => {
        releaseAudio = resolve;
      });
      await page.route("**/fixture-media/audio", async (route) => {
        await audioGate;
        await route.continue();
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => window.probe && document.querySelectorAll("audio").length === 3,
      );
      assert.equal(await page.locator('audio[src^="blob:"]').count(), 0);
      await page.locator("#start").click();
      if (state === "hidden") await page.evaluate(() => probe.hiddenPlay());
      if (state === "disposed") await page.evaluate(() => probe.runtime.dispose());
      releaseAudio();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("audio")].every((node) => node.readyState >= 2),
      );
      if (state !== "disposed") {
        await page.waitForFunction(() => {
          const node = document.querySelector('[aria-label="bg"]');
          return !node.paused && node.currentTime > 0;
        });
      }
      if (state === "playing") {
        await page.waitForFunction(() => !document.querySelector('[aria-label="spatial"]').paused);
      } else {
        assert.equal(
          await page.locator('[aria-label="spatial"]').evaluate((node) => node.paused),
          true,
        );
      }
      if (state === "disposed")
        assert.equal(await page.locator('[aria-label="bg"]').evaluate((node) => node.paused), true);
      assert.equal(
        await page.locator('[aria-label="hidden-audio"]').evaluate((node) => node.paused),
        true,
      );
      await page.evaluate((disposed) => {
        if (!disposed) probe.runtime.dispose();
        probe.unmount();
      }, state === "disposed");
      await page.unroute("**/fixture-media/audio");
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
