import * as THREE from "three";
import { createDisplayContent } from "../editor/graphics/display-content";
import { createActionRunner } from "../editor/interaction/actionHandler";
import { createVisitorPlayback } from "../shared/player/playback";

const audioUrl = "/fixture-media/audio";
const videoUrl = "/fixture-media/video";
const pose = { position: [0, 0, 5], rotation: [0, 0, 0, 1], fovDegrees: 60 };
const transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const attempts = [];
const pauses = [];
const loads = [];
const play = HTMLMediaElement.prototype.play;
const pause = HTMLMediaElement.prototype.pause;
const load = HTMLMediaElement.prototype.load;
HTMLMediaElement.prototype.play = function () {
  const result = play.call(this);
  function observe(outcome) {
    attempt.reportsBeforeCompletion = window.mediaProbe.visit?.reports.length ?? 0;
    return outcome;
  }
  const attempt = {
    node: this,
    outcome: result.then(
      () => observe("playing"),
      (error) => observe(error.name),
    ),
    reportsBeforeCompletion: 0,
  };
  attempts.push(attempt);
  return result;
};
HTMLMediaElement.prototype.pause = function () {
  const result = pause.call(this);
  pauses.push(this);
  return result;
};
HTMLMediaElement.prototype.load = function () {
  loads.push(this.getAttribute("src"));
  return load.call(this);
};

function once(target, event) {
  return new Promise((resolve) => target.addEventListener(event, resolve, { once: true }));
}

function whenReady(node) {
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const check = () => {
      if (node.error) {
        listeners.abort();
        reject(new Error(node.error.message || "The media fixture did not load"));
      } else if (node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        listeners.abort();
        resolve();
      }
    };
    for (const event of ["loadeddata", "canplay", "error"])
      node.addEventListener(event, check, { signal: listeners.signal });
    check();
  });
}

function timeRule(seconds, visible, playAgain = false) {
  return {
    id: `visibility-${seconds}`,
    enabled: true,
    trigger: { type: "elapsed", seconds },
    actions: [
      { type: "setVisible", objectId: "OWNER-0", visible },
      ...(playAgain ? [{ type: "playMedia", mediaId: "0" }] : []),
    ],
  };
}

async function makeVisit(count, rules = []) {
  const camera = new THREE.PerspectiveCamera();
  const content = document.createElement("main");
  const status = document.createElement("output");
  content.append(status);
  const owners = [];
  const panels = [];
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const owner = document.createElement("article");
    owner.dataset.ownerId = `owner-${i}`;
    const panel = document.createElement("section");
    panel.dataset.componentId = String(i);
    const audio = new Audio(audioUrl);
    audio.dataset.background = "true";
    audio.preload = "auto";
    audio.loop = true;
    panel.append(audio);
    owner.append(panel);
    content.append(owner);
    owners.push(owner);
    panels.push(panel);
    nodes.push(audio);
  }
  document.body.append(content);
  const reports = [];
  const runtime = createVisitorPlayback(
    { id: "scene", name: "Native media", startCamera: pose, objects: [], rules },
    camera,
    { target: new THREE.Vector3(), update() {} },
    new Map(),
    content,
    () => false,
    (message) => {
      reports.push(message);
      status.value = message;
    },
  );
  await Promise.all(nodes.map(whenReady));
  return { runtime, reports, owners, panels, nodes, camera };
}

function asset(id, kind, url, options = {}) {
  return { id, name: id, kind, url, sha256: "0".repeat(64), thumbnail: null, ...options };
}

function makeStand(url) {
  const stand = asset("stand", "model", "", {
    displayRole: "digital",
    displaySurface: { position: [0, 1, 0], rotation: [0, 0, 0, 1], width: 1, height: 1 },
  });
  const videoAsset = asset("movie", "video", url);
  const object = {
    id: "object",
    assetId: stand.id,
    name: "Stand",
    transform,
    components: [
      {
        id: "content",
        type: "video",
        assetId: "movie",
        caption: "Caption",
        loop: false,
        volume: 0.5,
      },
    ],
  };
  const owner = new THREE.Group();
  const owners = new Map([[object.id, owner]]);
  const display = createDisplayContent([stand, videoAsset], () => {
    document.dispatchEvent(new Event("display-resource-loaded"));
  });
  const ready = once(document, "display-resource-loaded");
  display.sync([object], owners);
  return {
    object,
    owner,
    owners,
    display,
    ready,
    stand,
    videoAsset,
    video: () => owner.children[0]?.children[0]?.material.map.image,
  };
}

function caseText() {
  const surface = asset("case", "model", "", { displayRole: "physical", displayTop: 1 });
  const model = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.position.y = 0.5;
  model.add(mesh);
  const owner = new THREE.Group();
  owner.add(model.clone(true));
  const display = createDisplayContent([surface], () => {}, new Map([[surface.id, model]]));
  display.sync(
    [
      {
        id: "case",
        assetId: surface.id,
        name: "Case",
        transform,
        appearance: { color: "#3d3133", material: "plain" },
        components: [
          { id: "label", type: "text", runs: [{ text: "Case text", marks: [] }], caption: "" },
        ],
      },
    ],
    new Map([["case", owner]]),
  );
  const label = owner.getObjectByName("Display content").children[0];
  const canvas = label.material.map.image;
  const context = canvas.getContext("2d");
  const result = {
    transparent: label.material.transparent,
    cornerAlpha: context.getImageData(0, 0, 1, 1).data[3],
    fill: context.fillStyle,
  };
  display.dispose();
  return result;
}

function missingStandMedia() {
  const { stand, videoAsset, object } = window.mediaProbe.display;
  const before = loads.length;
  const fallback = [
    [stand],
    [stand, { ...videoAsset, kind: "image", url: "/unexpected-stand-media" }],
  ].map((assets) => {
    const owner = new THREE.Group();
    const display = createDisplayContent(assets, () => {});
    display.sync([object], new Map([[object.id, owner]]));
    const hasFallback = owner.children[0]?.children[0]?.material.map instanceof THREE.CanvasTexture;
    display.dispose();
    return hasFallback;
  });
  return { fallback, loads: loads.slice(before) };
}

async function settleMedia() {
  return Promise.all(attempts.map((record) => record.outcome));
}

const scenario = new URL(location.href).searchParams.get("case");
const gesture = document.querySelector("#activate");
const probe = { attempts, pauses, settleMedia, caseText, missingStandMedia };
window.mediaProbe = probe;

if (scenario === "actions") {
  const spatial = new Audio(audioUrl);
  const linked = new Map([
    ["track", { url: audioUrl, loop: true, volume: 0.4 }],
    [
      "spatial",
      {
        url: audioUrl,
        loop: false,
        volume: 1,
        play: () => {
          void spatial.play();
        },
      },
    ],
  ]);
  const runner = createActionRunner(undefined, (id) => linked.get(id));
  const other = createActionRunner();
  probe.actions = { runner, other, spatial };
  gesture.addEventListener("click", () => runner.run({ type: "play-audio", url: audioUrl }));
} else if (scenario === "display" || scenario === "display-denied") {
  const stand = makeStand(scenario === "display-denied" ? audioUrl : videoUrl);
  stand.display.toggle(stand.object.id);
  const attemptedBeforeLoad = attempts.length;
  await stand.ready;
  await settleMedia();
  probe.display = { ...stand, attemptedBeforeLoad };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stand.display.pause();
    else stand.display.resume();
  });
} else if (scenario === "context") {
  const visit = await makeVisit(0);
  const closed = new AudioContext();
  await closed.close();
  THREE.AudioContext.setContext(closed);
  visit.runtime.start();
  await closed.resume().catch(() => {});
  gesture.addEventListener("click", () => {
    const listener = visit.camera.children.find((child) => child instanceof THREE.AudioListener);
    listener.context = new AudioContext();
    visit.runtime.start();
  });
  probe.visit = visit;
} else {
  const count = ["hide-one", "partial"].includes(scenario) ? 2 : 1;
  const visit = await makeVisit(count, [
    timeRule(1, false),
    timeRule(2, true, scenario === "fresh" || scenario === "superseded"),
  ]);
  probe.visit = visit;
  visit.runtime.begin();
  if (["hidden-pending", "shown-pending", "fresh", "superseded"].includes(scenario)) {
    visit.runtime.update(1);
    if (scenario === "shown-pending" || scenario === "superseded") visit.runtime.update(1);
  }
  await settleMedia();
  gesture.addEventListener("click", () => {
    visit.runtime.start();
    if (scenario === "disposed") visit.runtime.dispose();
    if (scenario === "fresh") visit.runtime.update(1);
  });
}

console.info("Native media fixture ready");
document.dispatchEvent(new Event("native-media-ready"));
