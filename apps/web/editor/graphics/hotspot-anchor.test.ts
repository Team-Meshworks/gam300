import { describe, expect, it } from "vitest";
import { Box3, BoxGeometry, Group, Mesh, PerspectiveCamera, Vector3, Euler } from "three";
import { HOTSPOT_SIZE, hotspotAnchor } from "./hotspot-anchor";

function cameraAt(position = [0, 0, 50], target = [0, 0, 0]) {
  const camera = new PerspectiveCamera(40, 1.4, 0.1, 1000);
  camera.position.fromArray(position);
  camera.lookAt(new Vector3(...target));
  camera.updateMatrixWorld();
  return camera;
}

function verifyVisibleCorner(model: Group | Mesh, owner: Group, camera: PerspectiveCamera) {
  const anchor = hotspotAnchor(model, owner, camera)!;
  expect(anchor).toBeDefined();
  const bounds = new Box3().setFromObject(model);
  const projected = new Box3();
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z])
        projected.expandByPoint(owner.localToWorld(new Vector3(x, y, z)).project(camera));
  const centre = owner.localToWorld(
    new Vector3(...anchor).add(new Vector3(0, HOTSPOT_SIZE / 2, 0)),
  );
  const markerScale = owner.getWorldScale(new Vector3());
  const markerSize = HOTSPOT_SIZE * Math.min(markerScale.x, markerScale.y);
  const right = centre
    .clone()
    .add(new Vector3(markerSize / 2, 0, 0).applyQuaternion(camera.quaternion))
    .project(camera);
  const bottom = centre
    .clone()
    .add(new Vector3(0, -markerSize / 2, 0).applyQuaternion(camera.quaternion))
    .project(camera);
  const horizontalGap = projected.min.x - right.x;
  const verticalGap = bottom.y - projected.max.y;
  expect(horizontalGap).toBeGreaterThan(0);
  expect(verticalGap).toBeGreaterThan(0);
  // Small clearance, measured against visible size in the same screen units.
  expect(horizontalGap).toBeLessThan(
    Math.max(
      projected.max.x - projected.min.x,
      (projected.max.y - projected.min.y) / camera.aspect,
    ) * 0.05,
  );
  expect(verticalGap).toBeLessThan(
    Math.max(
      (projected.max.x - projected.min.x) * camera.aspect,
      projected.max.y - projected.min.y,
    ) * 0.05,
  );
  return anchor;
}

describe("visible upper-left hotspot anchor", () => {
  it.each([
    [0.05, 0.08, 0.02],
    [1, 1, 1],
    [4, 0.5, 0.02],
    [0.4, 6, 0.1],
    [12, 8, 10],
  ])("clears the visible left and top edges of a %s x %s x %s model", (width, height, depth) => {
    const model = new Mesh(new BoxGeometry(width, height, depth));
    verifyVisibleCorner(model, new Group(), cameraAt());
    model.geometry.dispose();
  });

  it("honours nested authored offsets and off-centre model origins", () => {
    const model = new Group();
    const mesh = new Mesh(new BoxGeometry(2, 4, 0.5));
    mesh.position.set(-3, 5, -2);
    model.add(mesh);
    model.position.set(10, -1, 7);
    model.scale.set(2, 0.5, 3);
    verifyVisibleCorner(model, new Group(), cameraAt());
    mesh.geometry.dispose();
  });

  it.each([
    [
      [3, 2, -5],
      [0, Math.PI / 2, 0],
      [1, 1, 1],
      [0, 0, 50],
    ],
    [
      [-2, 7, 4],
      [0.3, 0.8, -0.6],
      [0.2, 3, 1.4],
      [20, 30, 50],
    ],
    [
      [0, 0, 0],
      [0, Math.PI, 0],
      [4, 0.5, 2],
      [0, 0, 50],
    ],
    [
      [0, 0, 0],
      [0, 0, Math.PI / 2],
      [0.5, 2, 1],
      [-30, 10, -40],
    ],
  ])(
    "uses the viewer's left for transformed objects and different camera angles",
    (p, r, s, eye) => {
      const model = new Mesh(new BoxGeometry(2, 4, 1));
      const owner = new Group();
      owner.position.fromArray(p);
      owner.quaternion.setFromEuler(new Euler(r[0], r[1], r[2]));
      owner.scale.fromArray(s);
      const camera = cameraAt(eye, p);
      const anchor = verifyVisibleCorner(model, owner, camera);
      expect(hotspotAnchor(model, owner, camera)).toEqual(anchor);
      // The persisted local point remains stable; subsequent movement uses the owner.
      const marker = new Group();
      marker.position.fromArray(anchor);
      owner.add(marker);
      const original = marker.getWorldPosition(new Vector3());
      owner.position.x += 3;
      expect(
        marker.getWorldPosition(new Vector3()).distanceTo(original.add(new Vector3(3, 0, 0))),
      ).toBeLessThan(1e-12);
      expect(marker.position.toArray()).toEqual(anchor);
      model.geometry.dispose();
    },
  );

  it("rejects empty, degenerate, non-finite and camera-clipped bounds", () => {
    const owner = new Group();
    const camera = cameraAt();
    expect(hotspotAnchor(new Group(), owner, camera)).toBeUndefined();
    const mesh = new Mesh(new BoxGeometry(0, 0, 0));
    expect(hotspotAnchor(mesh, owner, camera)).toBeUndefined();
    mesh.geometry.dispose();
    mesh.geometry = new BoxGeometry(1, 1, 1);
    mesh.position.x = Infinity;
    expect(hotspotAnchor(mesh, owner, camera)).toBeUndefined();
    mesh.position.set(0, 0, 50);
    expect(hotspotAnchor(mesh, owner, camera)).toBeUndefined();
    mesh.geometry.dispose();
  });
});
