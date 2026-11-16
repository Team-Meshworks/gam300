import { readFile } from "node:fs/promises";
import { Box3, Group, PerspectiveCamera, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { FpsControls } from "./FpsControls";
import { createWalkSpace } from "./walk-space";

let room: Group;
beforeAll(async () => {
  const bytes = await readFile(
    new URL("../../../../assets/delivery/test-room.glb", import.meta.url),
  );
  // Keep the real geometry but omit textures, which require browser image decoding
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  delete gltf.images;
  delete gltf.textures;
  delete gltf.materials;
  for (const mesh of gltf.meshes)
    for (const primitive of mesh.primitives) delete primitive.material;
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 32)]);
  const binary = bytes.subarray(20 + jsonLength);
  const glb = Buffer.alloc(20 + padded.length + binary.length);
  glb.write("glTF");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12);
  glb.write("JSON", 16);
  padded.copy(glb, 20);
  binary.copy(glb, 20 + padded.length);
  const model = (await new GLTFLoader().parseAsync(Uint8Array.from(glb).buffer, "")).scene;
  const bounds = new Box3().setFromObject(model);
  const center = bounds.getCenter(new Vector3());
  model.position.sub(new Vector3(center.x, bounds.min.y, center.z));
  room = new Group();
  room.add(model);
});

afterEach(() => vi.unstubAllGlobals());

it.each(["initial engagement", "viewpoint sync", "room visibility resync"])(
  "holds authored poses until movement at %s, then resumes room collision",
  (phase) => {
    const events = new EventTarget();
    vi.stubGlobal("document", new EventTarget());
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    const camera = new PerspectiveCamera();
    const controls = new FpsControls(camera, new EventTarget() as HTMLElement);
    controls.setFlightAllowed(false);
    controls.setWalkSpace(createWalkSpace([room]));
    try {
      if (phase !== "initial engagement") controls.engage();
      // The GLB floor slab is 0.2 m above its normalized lower bound
      for (const position of [
        [-5, 4, 8],
        [-5, 1.1, 0],
        [0, -2, 0],
      ]) {
        camera.position.fromArray(position);
        camera.rotation.set(0.2, 0.3, 0.1);
        camera.fov = 45;
        const pose = camera.clone();
        if (phase === "initial engagement") controls.engage();
        else if (phase === "viewpoint sync") controls.syncFromCamera();
        else controls.setWalkSpace(createWalkSpace([room]));
        for (let i = 0; i < 60; i++) controls.update(1 / 60);
        expect(camera.position.toArray()).toEqual(pose.position.toArray());
        expect(camera.quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
        expect(camera.fov).toBe(45);
        controls.mobileControls.setLook(20, 10);
        controls.update(1 / 60);
        expect(camera.position.toArray()).toEqual(pose.position.toArray());
        expect(camera.quaternion.angleTo(pose.quaternion)).toBeGreaterThan(0.01);
        controls.mobileControls.setMove(1, 0);
        for (let i = 0; i < 300; i++) controls.update(1 / 60);
        expect(camera.position.x).toBeGreaterThan(4.4);
        expect(camera.position.x).toBeLessThan(4.8);
        expect(camera.position.y).toBeCloseTo(1.1);
        expect(Math.abs(camera.position.z)).toBeLessThan(4.8);
        controls.mobileControls.setMove(0, 0);
        if (phase === "initial engagement") controls.disengage();
      }
    } finally {
      controls.dispose();
    }
  },
);

it.each(["initial engagement", "runtime room visibility resync"])(
  "preserves the view and look controls when tilted-room walking is unavailable at %s",
  (phase) => {
    const events = new EventTarget();
    vi.stubGlobal("document", new EventTarget());
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    const tilted = room.clone(true);
    tilted.quaternion.set(0.08715574274765817, 0, 0, 0.9961946980917455);
    const camera = new PerspectiveCamera();
    camera.position.set(0, 0.9, 0);
    camera.rotation.set(0.2, 0.3, 0.1);
    const controls = new FpsControls(camera, new EventTarget() as HTMLElement);
    controls.setFlightAllowed(false);
    try {
      if (phase === "runtime room visibility resync") {
        controls.setWalkSpace(createWalkSpace([room]));
        controls.engage();
        controls.mobileControls.setMove(1, 0);
        for (let i = 0; i < 30; i++) controls.update(1 / 60);
        expect(camera.position.length()).toBeGreaterThan(1);
      }
      const pose = camera.clone();
      controls.setWalkSpace(createWalkSpace([tilted]));
      controls.engage();
      controls.mobileControls.setMove(1, 1);
      controls.mobileControls.jump();
      for (let i = 0; i < 60; i++) controls.update(1 / 60);
      expect(camera.position.toArray()).toEqual(pose.position.toArray());
      expect(camera.quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
      expect(controls.isEngaged()).toBe(true);
      controls.mobileControls.setLook(20, 10);
      controls.update(1 / 60);
      expect(camera.quaternion.angleTo(pose.quaternion)).toBeGreaterThan(0.01);

      // Hotspot/viewpoint restoration must synchronize its new pose even in fallback
      camera.position.set(1, 1.2, 1);
      camera.rotation.set(-0.1, 0.6, 0);
      const viewpoint = camera.clone();
      controls.syncFromCamera();
      for (let i = 0; i < 60; i++) controls.update(1 / 60);
      expect(camera.position.toArray()).toEqual(viewpoint.position.toArray());
      expect(camera.quaternion.angleTo(viewpoint.quaternion)).toBeLessThan(1e-6);

      // A later usable room restores walking and still blocks its solid outer wall
      camera.position.set(0, 0.9, 0);
      camera.rotation.set(0, 0, 0);
      controls.setWalkSpace(createWalkSpace([room]));
      controls.mobileControls.setMove(1, 0);
      for (let i = 0; i < 300; i++) controls.update(1 / 60);
      expect(camera.position.x).toBeGreaterThan(4.4);
      expect(camera.position.x).toBeLessThan(4.8);
    } finally {
      controls.dispose();
    }
  },
);

it("reports unsupported placement without changing the authored position", () => {
  const tilted = room.clone(true);
  tilted.quaternion.set(0.08715574274765817, 0, 0, 0.9961946980917455);
  const eye = new Vector3(2, 3, 4);
  expect(createWalkSpace([tilted]).place(eye)).toBeUndefined();
  expect(eye.toArray()).toEqual([2, 3, 4]);
});
