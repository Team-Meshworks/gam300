import { Box3, BoxGeometry, Group, Mesh, Object3D, Vector3 } from "three";
import type { AudioListener, PositionalAudio } from "three";
import { describe, expect, it } from "vitest";
import { createRoomEntrances } from "../asset-runtime/room-entrances";
import {
  ECHO_EMPTINESS,
  EMPTY_WET,
  FULL_COVERAGE,
  FURNISHED_WET,
  MANY_WALLS,
  ONE_WALL,
  OPEN,
  REVERB_BUCKETS,
  buildImpulse,
  createRoomAcoustics,
  reverbBucket,
  reverbFor,
  roomEmptiness,
} from "./room-acoustics";

// Minimal Web Audio stand-in: parameters jump straight to their targets
class FakeParam {
  value = 0;
  setTargetAtTime(value: number) {
    this.value = value;
  }
  cancelScheduledValues() {}
}
class FakeNode {
  connections = new Set<FakeNode>();
  connect(node: FakeNode) {
    this.connections.add(node);
    return node;
  }
  disconnect(node?: FakeNode) {
    if (node) this.connections.delete(node);
    else this.connections.clear();
  }
}
class FakeGain extends FakeNode {
  gain = Object.assign(new FakeParam(), { value: 1 });
}
class FakeFilter extends FakeNode {
  type = "";
  frequency = new FakeParam();
}
class FakeConvolver extends FakeNode {
  buffer: unknown = null;
}
// Inverse-distance rolloff like Three's PositionalAudio defaults (refDistance 3, rolloff 1)
class FakePanner extends FakeNode {
  owner: Object3D;
  listener: Object3D;
  constructor(owner: Object3D, listener: Object3D) {
    super();
    this.owner = owner;
    this.listener = listener;
  }
  factor() {
    const distance = this.owner
      .getWorldPosition(new Vector3())
      .distanceTo(this.listener.getWorldPosition(new Vector3()));
    return 3 / (3 + Math.max(distance, 3) - 3);
  }
}
// Signal level from one node to another: the product of gains and distance rolloff along each path
function level(from: FakeNode, to: FakeNode): number {
  if (from === to) return 1;
  const own =
    from instanceof FakeGain ? from.gain.value : from instanceof FakePanner ? from.factor() : 1;
  let sum = 0;
  for (const next of from.connections) sum += level(next, to);
  return own * sum;
}
function fakeContext() {
  const nodes: FakeNode[] = [];
  const track = <T extends FakeNode>(node: T) => (nodes.push(node), node);
  return {
    nodes,
    sampleRate: 1000,
    currentTime: 0,
    createGain: () => track(new FakeGain()),
    createBiquadFilter: () => track(new FakeFilter()),
    createConvolver: () => track(new FakeConvolver()),
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, getChannelData: (i: number) => data[i]! };
    },
  };
}

function setup(listenerAt: Vector3) {
  const context = fakeContext();
  const input = new FakeGain();
  const listener = new Object3D() as unknown as AudioListener;
  Object.assign(listener, { context, getInput: () => input });
  (listener as unknown as Object3D).position.copy(listenerAt);
  const acoustics = createRoomAcoustics(listener);
  const source = (at: Vector3) => {
    // Mirrors Three's PositionalAudio graph: source -> filters -> panner -> gain (volume) -> listener
    const origin = new FakeNode();
    const owner = new Object3D();
    const panner = new FakePanner(owner, listener as unknown as Object3D);
    const gain = new FakeGain();
    panner.connect(gain);
    gain.connect(input);
    const fake = Object.assign(owner, {
      origin,
      gain,
      filters: [] as FakeNode[],
      setFilters(value: FakeNode[]) {
        origin.disconnect();
        fake.filters = value;
        [origin, ...value, panner].reduce((prev, next) => prev.connect(next));
      },
    });
    fake.position.copy(at);
    const sound = fake as unknown as PositionalAudio;
    acoustics.attach(sound);
    const [lowpass, occlusion] = fake.filters as [FakeFilter, FakeGain];
    const send = [...gain.connections].find((node) => node !== input) as FakeGain;
    return { sound, lowpass, occlusion, send, origin, gain };
  };
  // The bus is the gain feeding the convolvers
  const bus = () =>
    context.nodes.find(
      (node) =>
        node instanceof FakeGain &&
        [...node.connections].some((next) => next instanceof FakeConvolver),
    )!;
  const wets = () =>
    context.nodes
      .filter((node): node is FakeGain => node instanceof FakeGain && node.connections.has(input))
      .map((node) => node.gain.value);
  return { acoustics, source, wets, context, bus, input };
}

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
  root.updateWorldMatrix(true, true);
  return root;
}

describe("room acoustics", () => {
  it("leaves a source in the listener's room open", () => {
    const { acoustics, source } = setup(new Vector3(-2, 0.9, 0));
    acoustics.setRooms([room()]);
    const { lowpass, occlusion } = source(new Vector3(2, 0, 2));
    acoustics.update(0.016);
    expect(occlusion.gain.value).toBe(OPEN.gain);
    expect(lowpass.frequency.value).toBe(OPEN.cutoff);
  });

  it("muffles a neighbour behind a solid shared wall as one barrier", () => {
    const { acoustics, source } = setup(new Vector3(0, 0.9, 3));
    acoustics.setRooms([room(), room(10)]);
    const { lowpass, occlusion, send } = source(new Vector3(10, 0.5, 3));
    acoustics.update(0.016);
    expect(occlusion.gain.value).toBe(ONE_WALL.gain);
    expect(lowpass.frequency.value).toBe(ONE_WALL.cutoff);
    expect(send.gain.value).toBeGreaterThan(0.25);
  });

  it("lets sound through a connecting doorway", () => {
    const rooms = [room(), room(10)];
    createRoomEntrances().sync(rooms);
    const { acoustics, source } = setup(new Vector3(0, 0.9, 0));
    acoustics.setRooms(rooms);
    const { occlusion, lowpass } = source(new Vector3(10, 0.9, 0));
    acoustics.update(0.016);
    expect(occlusion.gain.value).toBe(OPEN.gain);
    expect(lowpass.frequency.value).toBe(OPEN.cutoff);
  });

  it("muffles further through several rooms", () => {
    const { acoustics, source } = setup(new Vector3(0, 0.9, 3));
    acoustics.setRooms([room(), room(10), room(20)]);
    const { occlusion } = source(new Vector3(20, 0.5, 3));
    acoustics.update(0.016);
    expect(occlusion.gain.value).toBe(MANY_WALLS.gain);
  });

  it("re-checks occlusion as the source moves", () => {
    const { acoustics, source } = setup(new Vector3(0, 0.9, 3));
    acoustics.setRooms([room(), room(10)]);
    const { sound, occlusion } = source(new Vector3(10, 0.5, 3));
    acoustics.update(0.016);
    (sound as unknown as Object3D).position.set(2, 0.5, 3);
    acoustics.update(0.2);
    expect(occlusion.gain.value).toBe(OPEN.gain);
  });

  it("enables only the listener room's reverb and none outdoors", () => {
    const inside = setup(new Vector3(0, 0.9, 0));
    inside.acoustics.setRooms([room()]);
    inside.acoustics.update(0.016);
    // A bare 10 x 10 x 3 m gallery is a medium room at its emptiest
    const levels = inside.wets().filter((wet) => wet > 0);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toBeCloseTo(REVERB_BUCKETS[1].wet * EMPTY_WET);

    const outside = setup(new Vector3(50, 0.9, 0));
    outside.acoustics.setRooms([room()]);
    outside.acoustics.update(0.016);
    expect(outside.wets().every((wet) => wet === 0)).toBe(true);
  });

  it("silences a source's reverb along with its dry signal at zero volume", () => {
    const { acoustics, source, bus, input } = setup(new Vector3(-3, 0.9, 0));
    acoustics.setRooms([room()]);
    const { origin, gain } = source(new Vector3(1, 0.9, 0));
    acoustics.update(0.016);
    expect(level(origin, bus())).toBeGreaterThan(0);
    gain.gain.value = 0;
    expect(level(origin, input)).toBe(0);
    expect(level(origin, bus())).toBe(0);
  });

  it("lowers what feeds the reverb with distance inside one room", () => {
    // Same room, no walls between, and the listener's room reverb stays fixed
    const { acoustics, source, bus, input, wets } = setup(new Vector3(-4, 0.9, 0));
    acoustics.setRooms([room()]);
    const near = source(new Vector3(-0.5, 0.9, 0));
    const far = source(new Vector3(4, 0.9, 0));
    acoustics.update(0.016);
    const roomReverb = wets().filter((wet) => wet > 0);
    expect(near.occlusion.gain.value).toBe(OPEN.gain);
    expect(far.occlusion.gain.value).toBe(OPEN.gain);
    const nearWet = level(near.origin, bus());
    const farWet = level(far.origin, bus());
    expect(farWet).toBeLessThan(nearWet);
    // The send follows the dry signal's distance rolloff exactly
    expect(farWet / nearWet).toBeCloseTo(level(far.origin, input) / level(near.origin, input));
    expect(wets().filter((wet) => wet > 0)).toEqual(roomReverb);
  });

  // The same 10 m room yawed 45°, with the rotation authored on the root, on a child, or in the vertices
  const rotated = (where: "root" | "child" | "baked") => () => {
    const root = room();
    if (where === "root") root.rotation.y = Math.PI / 4;
    else {
      const child = new Group();
      child.add(...root.children);
      child.rotation.y = Math.PI / 4;
      root.add(child);
      if (where === "baked") {
        child.updateWorldMatrix(true, true);
        for (const mesh of [...child.children] as Mesh[]) {
          mesh.geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
          mesh.position.set(0, 0, 0);
          root.add(mesh);
        }
        root.remove(child);
      }
    }
    root.updateWorldMatrix(true, true);
    return root;
  };
  it.each(["root", "child", "baked"] as const)(
    "keeps a room rotated on its %s inside its walls",
    (where) => {
      const rotatedRoom = rotated(where);
      // (6, 1, 6) lies 8.5 m along the room's local axis, beyond its 5 m wall
      const beyond = setup(new Vector3(6, 1, 6));
      beyond.acoustics.setRooms([rotatedRoom()]);
      beyond.acoustics.update(0.016);
      expect(beyond.wets().every((wet) => wet === 0)).toBe(true);

      // Inside, it rings exactly like the same room unrotated
      const inside = setup(new Vector3(2, 1, 2));
      inside.acoustics.setRooms([rotatedRoom()]);
      inside.acoustics.update(0.016);
      const levels = inside.wets().filter((wet) => wet > 0);
      expect(levels).toHaveLength(1);
      expect(levels[0]).toBeCloseTo(REVERB_BUCKETS[1].wet * EMPTY_WET);
    },
  );

  it("restores the sound's chain and disconnects its nodes on detach", () => {
    const { acoustics, source } = setup(new Vector3());
    const { sound, occlusion, send, gain } = source(new Vector3(1, 0, 0));
    acoustics.detach(sound);
    expect((sound as unknown as { filters: unknown[] }).filters).toEqual([]);
    expect(occlusion.connections.size).toBe(0);
    expect(send.connections.size).toBe(0);
    expect(gain.connections.has(send)).toBe(false);
  });

  it("sizes reverb buckets and impulses by room volume", () => {
    expect(reverbBucket(100)).toBe(0);
    expect(reverbBucket(300)).toBe(1);
    expect(reverbBucket(5000)).toBe(2);
    const context = fakeContext() as unknown as BaseAudioContext;
    const short = buildImpulse(context, 0.5, () => 1);
    const long = buildImpulse(context, 1.8, () => 1);
    expect(short.length).toBe(500);
    expect(long.length).toBe(1800);
    const tail = short.getChannelData(0)[short.length - 1]!;
    expect(tail).toBeGreaterThan(0);
    expect(tail).toBeLessThan(0.002);
  });

  // A 1 x 1 m footprint prop at (x, z) in world space
  function prop(x: number, z: number, width = 1) {
    const root = new Object3D();
    root.position.set(x, 0, z);
    root.updateWorldMatrix(true, false);
    const half = width / 2;
    return { root, bounds: new Box3(new Vector3(-half, 0, -half), new Vector3(half, 1, half)) };
  }

  it("measures emptiness from furniture floor coverage inside the room", () => {
    const box = new Box3(new Vector3(-5, 0, -5), new Vector3(5, 3, 5));
    expect(roomEmptiness(box, [])).toBe(1);
    // Cover half of the floor share that counts as fully furnished with 1 x 1 m props
    const count = Math.round((100 * FULL_COVERAGE) / 2);
    const half = Array.from({ length: count }, (_, i) =>
      prop(-4 + (i % 5) * 2, -4 + Math.floor(i / 5) * 2),
    );
    expect(roomEmptiness(box, half)).toBeCloseTo(1 - count / (100 * FULL_COVERAGE));
    expect(roomEmptiness(box, [prop(0, 0, 8)])).toBe(0);
    // Props in another room or hidden props do not dampen this one
    const hidden = prop(0, 0, 8);
    hidden.root.visible = false;
    expect(roomEmptiness(box, [prop(20, 0, 8), hidden])).toBe(1);
  });

  it("makes empty rooms wetter and longer than furnished ones", () => {
    const furnished = reverbFor(300, 0);
    const empty = reverbFor(300, 1);
    expect(furnished).toEqual({ bucket: 1, wet: REVERB_BUCKETS[1].wet * FURNISHED_WET });
    expect(empty.bucket).toBe(2);
    expect(empty.wet).toBeCloseTo(REVERB_BUCKETS[1].wet * EMPTY_WET);
    expect(reverbFor(300, ECHO_EMPTINESS - 0.01).bucket).toBe(1);
    expect(reverbFor(5000, 1).bucket).toBe(REVERB_BUCKETS.length - 1);
  });

  it("dries the listener's room out as furniture is added", () => {
    const { acoustics, wets } = setup(new Vector3(0, 0.9, 0));
    acoustics.setRooms([room()]);
    acoustics.update(0.016);
    const [emptyLevel] = wets().filter((wet) => wet > 0);
    acoustics.setProps([prop(0, 0, 8)]);
    acoustics.update(0.016);
    const [furnishedLevel] = wets().filter((wet) => wet > 0);
    expect(emptyLevel).toBeGreaterThan(furnishedLevel!);
    expect(wets().filter((wet) => wet > 0)).toHaveLength(1);
  });
});
