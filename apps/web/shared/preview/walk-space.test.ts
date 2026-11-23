import { Box3, BoxGeometry, Group, Mesh, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createRoomEntrances } from "../asset-runtime/room-entrances";
import { createWalkSpace } from "./walk-space";

function room(x = 0) {
  const root = new Group();
  const box = (name: string, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d));
    mesh.name = name;
    mesh.position.set(x, y, z);
    root.add(mesh);
  };
  box("floor", 10, 0.2, 10, 0, -0.1, 0);
  box("Wall_Left", 0.2, 3, 10, -4.9, 1.5, 0);
  box("Wall_Right", 0.2, 3, 10, 4.9, 1.5, 0);
  box("Wall_Front", 10, 3, 0.2, 0, 1.5, 4.9);
  box("Wall_Back", 10, 3, 0.2, 0, 1.5, -4.9);
  root.position.x = x;
  return root;
}

describe("walking inside rendered rooms", () => {
  const rooms = [room(), room(10)];
  rooms[1]!.rotation.y = Math.PI / 2;
  createRoomEntrances().sync(rooms);
  const walk = (z: number, dx: number, dz = 0) => {
    const space = createWalkSpace(rooms);
    const eye = new Vector3(0, 0.9, z);
    for (let i = 0; i < 650; i++) {
      const next = eye.clone().add(new Vector3(dx, 0, dz));
      space.move(eye, next);
      eye.copy(next);
    }
    return eye;
  };
  it("crosses both cut walls into a rotated neighbour and stops inside the far wall", () => {
    const eye = walk(0, 0.03);
    expect(eye.x).toBeGreaterThan(14.4);
    expect(eye.x).toBeLessThan(14.8);
  });
  it("blocks the jamb and slides along the wall", () => {
    const eye = walk(1.1, 0.03, 0.003);
    expect(eye.x).toBeLessThan(4.8);
    expect(eye.z).toBeGreaterThan(2.9);
  });
  it("keeps an unpaired opening over an exterior drop inside the floor footprint", () => {
    const open = room();
    open.remove(open.getObjectByName("Wall_Right")!);
    const space = createWalkSpace([open]);
    const eye = new Vector3(4.6, 0.9, 0);
    for (let i = 0; i < 60; i++) {
      const next = eye.clone().add(new Vector3(0.03, 0, 0));
      space.move(eye, next);
      eye.copy(next);
    }
    expect(eye.x).toBeGreaterThan(4.6);
    expect(eye.x).toBeLessThan(5);
  });
  it("recovers a saved view outside an elevated room to a walkable position", () => {
    const elevated = room(40);
    elevated.position.y = 6;
    const space = createWalkSpace([elevated]);
    const eye = new Vector3(-30, -10, 100);
    const floor = space.place(eye);
    expect(floor).toBeCloseTo(6);
    expect(eye.y).toBeCloseTo(6.9);
    expect(Math.abs(eye.x - 40)).toBeLessThan(4.8);
    expect(Math.abs(eye.z)).toBeLessThan(4.8);
  });
  it("allows a 0.5 m opening even on a diagonal, but blocks a gap narrower than the visitor", () => {
    for (const gap of [0.5, 0.38]) {
      const model = room();
      for (const side of [-1, 1]) {
        const width = 5 - gap / 2;
        const jamb = new Mesh(new BoxGeometry(0.12, 3, width));
        jamb.position.set(0, 1.5, (side * (width + gap)) / 2);
        model.add(jamb);
      }
      model.rotation.y = Math.PI / 4;
      const space = createWalkSpace([model]);
      const eye = model.localToWorld(new Vector3(-2, 0.9, 0));
      space.place(eye);
      const velocity = new Vector3(0.025, 0, 0).applyQuaternion(model.quaternion);
      for (let i = 0; i < 160; i++) {
        const next = eye.clone().add(velocity);
        space.move(eye, next);
        eye.copy(next);
      }
      const local = model.worldToLocal(eye);
      if (gap > 0.44) expect(local.x).toBeCloseTo(2);
      else expect(local.x).toBeLessThanOrEqual(-0.06 - Math.sqrt(0.22 ** 2 - 0.19 ** 2) + 0.0001);
    }
  });
  it("stops a jump under a lintel and lets the visitor walk out again", () => {
    const space = createWalkSpace(rooms);
    const eye = new Vector3(5, 0.9, 0);
    space.place(eye);
    for (let i = 0; i < 80; i++) {
      const next = eye.clone().add(new Vector3(0, 0.025, 0));
      space.move(eye, next);
      eye.copy(next);
    }
    expect(eye.y).toBeGreaterThan(1.6);
    expect(eye.y).toBeLessThanOrEqual(2.4 - (1.55 - 0.9) + 0.0001);
    for (let i = 0; i < 120; i++) {
      const next = eye.clone().add(new Vector3(0.025, -0.02, 0));
      space.move(eye, next);
      eye.copy(next);
    }
    expect(eye.x).toBeCloseTo(8);
    expect(eye.y).toBeCloseTo(0.9);
  });
});

describe("walking around placed assets", () => {
  const bounds = new Box3(new Vector3(-0.5, 0, -0.5), new Vector3(0.5, 1.5, 0.5));
  function advance(
    space: ReturnType<typeof createWalkSpace>,
    eye: Vector3,
    delta: Vector3,
    steps: number,
  ) {
    const next = new Vector3();
    for (let i = 0; i < steps; i++) {
      space.move(eye, next.copy(eye).add(delta));
      eye.copy(next);
    }
  }

  it("stops at the face of an offset, rotated and scaled display and slides along it", () => {
    const root = new Group();
    root.position.set(1, 0, -0.5);
    root.rotation.y = Math.PI / 4;
    root.scale.set(1.5, 0.8, 1);
    const offset = new Box3(new Vector3(0.2, 0, -1.6), new Vector3(0.5, 2, 1.6));
    const space = createWalkSpace([room()], [{ root, bounds: offset }]);
    const eye = root.localToWorld(new Vector3(-1, 0.9 / 0.8, -0.7));
    space.place(eye);
    advance(space, eye, new Vector3(0.025, 0, 0).applyQuaternion(root.quaternion), 120);
    const stop = root.worldToLocal(eye.clone());
    expect((0.2 - stop.x) * root.scale.x).toBeCloseTo(0.22, 1);
    advance(space, eye, new Vector3(0.01, 0, 0.02).applyQuaternion(root.quaternion), 80);
    const slid = root.worldToLocal(eye.clone());
    expect(slid.z).toBeGreaterThan(0.8);
    expect(slid.x).toBeCloseTo(stop.x, 1);
  });

  it("honours low furniture and visibility changes on the open floor", () => {
    const root = new Group();
    root.scale.y = 0.1;
    const space = createWalkSpace([], [{ root, bounds }]);
    const lowView = new Vector3(-2, 0, 0);
    expect(space.place(lowView)).toBe(0);
    expect(lowView.y).toBe(0);
    const eye = new Vector3(-1, 0.9, 0);
    const step = new Vector3(0.02, 0, 0);
    expect(space.place(eye)).toBe(0);
    advance(space, eye, step, 100);
    expect(eye.x).toBeLessThan(-0.5);
    root.visible = false;
    advance(space, eye, step, 35);
    expect(Math.abs(eye.x)).toBeLessThan(0.1);
    expect(space.insideProp(eye)).toBe(false);
    root.visible = true;
    expect(space.insideProp(eye)).toBe(true);
    expect(space.place(eye)).toBe(0);
    expect(space.insideProp(eye)).toBe(false);
  });

  it("leaves headroom under a raised exhibit and stops a jump against its underside", () => {
    const root = new Group();
    root.position.y = 1.8;
    const space = createWalkSpace([room()], [{ root, bounds }]);
    const eye = new Vector3(-1, 0.9, 0);
    space.place(eye);
    advance(space, eye, new Vector3(0.025, 0, 0), 40);
    expect(eye.x).toBeCloseTo(0);
    advance(space, eye, new Vector3(0, 0.025, 0), 50);
    expect(eye.y).toBeCloseTo(1.15, 1);
  });

  it("preserves a narrow aisle between diagonal stands and the space beside a tilted panel", () => {
    const left = new Group(),
      right = new Group();
    left.rotation.y = right.rotation.y = Math.PI / 4;
    left.position.set(-0.75, 0, 0).applyQuaternion(left.quaternion);
    right.position.copy(left.position).negate();
    const tilted = new Group();
    tilted.position.set(3, 0, 3);
    tilted.rotation.z = -Math.PI / 4;
    const space = createWalkSpace(
      [],
      [
        { root: left, bounds },
        { root: right, bounds },
        { root: tilted, bounds: new Box3(new Vector3(-0.05, 0, -0.5), new Vector3(0.05, 3, 0.5)) },
      ],
    );
    const eye = new Vector3(0, 0.9, -1.5).applyQuaternion(left.quaternion);
    space.place(eye);
    advance(space, eye, new Vector3(0, 0, 0.025).applyQuaternion(left.quaternion), 120);
    expect(eye.z).toBeCloseTo(1.5 * Math.cos(Math.PI / 4));
    expect(space.insideProp(new Vector3(3.7, 0.9, 3))).toBe(true);
    expect(space.insideProp(new Vector3(5.1, 0.9, 3))).toBe(false);
  });
});
