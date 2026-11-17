import { readFile } from "node:fs/promises";
import { Box3, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { expect, it } from "vitest";
import { createWalkSpace, EYE_HEIGHT } from "./walk-space";

it("does not walk through the capped edge of two snapped four-door rooms", async () => {
  const bytes = await readFile(
    new URL("../../../../assets/delivery/rooms/room-doors-1-2-3-4-v1.glb", import.meta.url),
  );
  // Textures are irrelevant to geometry; omit them so GLTFLoader works in Node.
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
  const other = model.clone();
  other.position.x += bounds.max.x - bounds.min.x;
  const walk = createWalkSpace([model, other]);
  const eye = new Vector3(14, 0.257 + EYE_HEIGHT, 0);
  walk.place(eye);
  for (let i = 0; i < 100; i++) {
    const next = eye.clone().add(new Vector3(0.03, 0, 0));
    walk.move(eye, next);
    eye.copy(next);
  }
  expect(eye.x).toBeGreaterThan(15);
  expect(eye.x).toBeLessThan(15.5);
});
