import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, Mesh, Quaternion, Vector3, Euler } from "three";
import { HOTSPOT_SIZE, hotspotAnchor } from "./hotspot-anchor";

describe("object-relative hotspot anchor", () => {
  it.each([
    [0.05, 0.08, 0.02],
    [1, 1, 1],
    [4, 0.5, 0.02],
    [0.4, 6, 0.1],
    [12, 8, 10],
  ])("clears the upper-right corner of a %s × %s × %s model", (width, height, depth) => {
    const model = new Mesh(new BoxGeometry(width, height, depth));
    const anchor = hotspotAnchor(model)!;
    const gap = Math.max(width, height, depth) * 0.08;
    // Marker bounds, not only its centre, are outside the exhibit.
    expect(anchor[0] - HOTSPOT_SIZE / 2).toBeCloseTo(width / 2 + gap);
    expect(anchor[1]).toBeCloseTo(height / 2 + gap);
    expect(anchor[2]).toBeCloseTo(depth / 2);
    model.geometry.dispose();
  });

  it("honours authored offsets, nested transforms and an off-centre model origin", () => {
    const model = new Group();
    const mesh = new Mesh(new BoxGeometry(2, 4, 0.5));
    mesh.position.set(-3, 5, -2);
    model.add(mesh);
    model.position.set(10, -1, 7);
    model.scale.set(2, 0.5, 3);
    expect(hotspotAnchor(model)).toEqual([6.62, 2.82, 1.75]);
    mesh.geometry.dispose();
  });

  it.each([
    [
      [3, 2, -5],
      [0, Math.PI / 2, 0],
      [1, 1, 1],
    ],
    [
      [-2, 7, 4],
      [0.3, 0.8, -0.6],
      [0.2, 3, 1.4],
    ],
    [
      [0, 0, 0],
      [0, Math.PI, 0],
      [4, 0.5, 2],
    ],
  ])("retains one local anchor through owner translation, rotation and scale", (p, r, s) => {
    const model = new Mesh(new BoxGeometry(2, 4, 1));
    const before = hotspotAnchor(model)!;
    const owner = new Group();
    owner.position.fromArray(p);
    owner.quaternion.setFromEuler(new Euler(r[0], r[1], r[2]));
    owner.scale.fromArray(s);
    owner.add(model.clone());
    const marker = new Group();
    marker.position.fromArray(before);
    owner.add(marker);
    const expected = new Vector3(...before)
      .multiply(new Vector3(...s))
      .applyQuaternion(new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2])))
      .add(new Vector3(...p));
    expect(marker.getWorldPosition(new Vector3()).distanceTo(expected)).toBeLessThan(1e-12);
    expect(hotspotAnchor(model)).toEqual(before);
    model.geometry.dispose();
  });

  it("rejects missing, degenerate and non-finite model bounds", () => {
    expect(hotspotAnchor(new Group())).toBeUndefined();
    const mesh = new Mesh(new BoxGeometry(0, 0, 0));
    expect(hotspotAnchor(mesh)).toBeUndefined();
    mesh.geometry.dispose();
    mesh.geometry = new BoxGeometry(1, 1, 1);
    mesh.position.x = Infinity;
    expect(hotspotAnchor(mesh)).toBeUndefined();
    mesh.geometry.dispose();
  });
});
