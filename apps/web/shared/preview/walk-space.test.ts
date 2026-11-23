import { BoxGeometry, Group, Mesh, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createRoomEntrances } from "../asset-runtime/room-entrances";
import { createWalkSpace, EYE_HEIGHT, touchesObject } from "./walk-space";

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
    const eye = new Vector3(0, EYE_HEIGHT, z);
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
    const eye = new Vector3(4.6, EYE_HEIGHT, 0);
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
    expect(eye.y).toBeCloseTo(6 + EYE_HEIGHT);
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
      const eye = model.localToWorld(new Vector3(-2, EYE_HEIGHT, 0));
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
    const eye = new Vector3(5, EYE_HEIGHT, 0);
    space.place(eye);
    for (let i = 0; i < 80; i++) {
      const next = eye.clone().add(new Vector3(0, 0.025, 0));
      space.move(eye, next);
      eye.copy(next);
    }
    expect(eye.y).toBeGreaterThan(1.6);
    expect(eye.y).toBeLessThanOrEqual(2.4 - (1.8 - 1.6) + 0.0001);
    for (let i = 0; i < 120; i++) {
      const next = eye.clone().add(new Vector3(0.025, -0.02, 0));
      space.move(eye, next);
      eye.copy(next);
    }
    expect(eye.x).toBeCloseTo(8);
    expect(eye.y).toBeCloseTo(EYE_HEIGHT);
  });
});

describe("visitor touching an object", () => {
  const exhibit = (x: number, y = 0.5) => {
    const root = new Group();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    mesh.position.set(x, y, 0);
    root.add(mesh);
    return root;
  };
  const eye = new Vector3(0, EYE_HEIGHT, 0);

  it("detects overlap with the visitor body box", () => {
    expect(touchesObject(exhibit(0), eye)).toBe(true);
  });

  it("ignores objects outside the body box", () => {
    expect(touchesObject(exhibit(0.8), eye)).toBe(false);
    expect(touchesObject(exhibit(0, 3), eye)).toBe(false);
  });

  it("uses the authored world transform", () => {
    const moved = exhibit(0);
    moved.position.x = 1;
    expect(touchesObject(moved, eye)).toBe(false);
    moved.position.x = 0.1;
    expect(touchesObject(moved, eye)).toBe(true);
  });

  it("ignores hidden objects", () => {
    const hidden = exhibit(0);
    hidden.visible = false;
    expect(touchesObject(hidden, eye)).toBe(false);
  });
});
