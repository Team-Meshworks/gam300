import * as THREE from "three";
import type { WalkProp } from "./walk-obstacles";

// Tuning for wall occlusion and room reverb. Levels are linear gains, cutoffs in Hz
// EXAGGERATED for listening tests: dial these back once the effect is confirmed audible
export const OPEN = { gain: 1, cutoff: 20000, send: 1 } as const;
export const ONE_WALL = { gain: 0.15, cutoff: 500, send: 2 } as const;
export const MANY_WALLS = { gain: 0.04, cutoff: 250, send: 2 } as const;
const BASE_SEND = 0.8;
// Back-to-back walls of neighbouring rooms, and both faces of one thick wall, are one barrier
const BARRIER_MERGE = 0.75;
const OCCLUSION_INTERVAL = 0.1;
const SMOOTHING = 0.08;
const ROOM_FADE = 0.1;
// Reverb character by listener-room volume (cubic metres)
export const REVERB_BUCKETS = [
  { maxVolume: 150, seconds: 1, wet: 0.6 },
  { maxVolume: 600, seconds: 2.2, wet: 0.8 },
  { maxVolume: Infinity, seconds: 4, wet: 1 },
] as const;
// Furniture absorbs sound: a room counts as fully furnished at this share of floor covered
// (0.05 = 5 m^2 of furniture in a 10 x 10 m gallery, roughly two or three benches)
export const FULL_COVERAGE = 0.05;
// Wet level scales from furnished to empty; a mostly empty room also rings one size longer
export const FURNISHED_WET = 0.1;
export const EMPTY_WET = 2;
export const ECHO_EMPTINESS = 0.5;
const FILL_INTERVAL = 0.5;

export function occlusionFor(barriers: number) {
  return barriers === 0 ? OPEN : barriers === 1 ? ONE_WALL : MANY_WALLS;
}

export function reverbBucket(volume: number) {
  return REVERB_BUCKETS.findIndex((bucket) => volume <= bucket.maxVolume);
}

// 1 for a bare floor, 0 once furniture covers FULL_COVERAGE of it. Hidden props do not count.
// `room` is in the room's local frame; `toLocal` maps world space into it (identity for unrotated rooms)
export function roomEmptiness(
  room: THREE.Box3,
  props: readonly WalkProp[],
  toLocal: THREE.Matrix4 = new THREE.Matrix4(),
) {
  const floor = (room.max.x - room.min.x) * (room.max.z - room.min.z);
  if (!(floor > 0)) return 1;
  const local = new THREE.Box3();
  const transform = new THREE.Matrix4();
  let covered = 0;
  for (const { root, bounds } of props) {
    if (!root.visible || bounds.isEmpty()) continue;
    root.updateWorldMatrix(true, false);
    transform.multiplyMatrices(toLocal, root.matrixWorld);
    local.copy(bounds).applyMatrix4(transform).intersect(room);
    if (!local.isEmpty()) covered += (local.max.x - local.min.x) * (local.max.z - local.min.z);
  }
  return 1 - Math.min(1, covered / floor / FULL_COVERAGE);
}

export function reverbFor(volume: number, emptiness: number) {
  const size = reverbBucket(volume);
  const bucket = emptiness >= ECHO_EMPTINESS ? Math.min(size + 1, REVERB_BUCKETS.length - 1) : size;
  const wet = REVERB_BUCKETS[size]!.wet * (FURNISHED_WET + (EMPTY_WET - FURNISHED_WET) * emptiness);
  return { bucket, wet };
}

// Stereo exponentially-decaying noise; amplitude reaches -60 dB at `seconds`
export function buildImpulse(context: BaseAudioContext, seconds: number, random = Math.random) {
  const length = Math.max(1, Math.round(context.sampleRate * seconds));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  const decay = Math.log(1000) / length;
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (random() * 2 - 1) * Math.exp(-decay * i);
  }
  return impulse;
}

type Wall = { triangle: THREE.Triangle; bounds: THREE.Box3 };
// Bounds live in the room's own frame so a rotated room is not inflated to a world-aligned box
type Room = { box: THREE.Box3; toLocal: THREE.Matrix4; volume: number };

// A wall's facing as a yaw folded into [0°, 90°), so perpendicular and opposite walls agree
function wallYaw(normal: THREE.Vector3) {
  const quarter = Math.PI / 2;
  return ((Math.atan2(normal.x, normal.z) % quarter) + quarter) % quarter;
}
// Candidate yaws grouped by whole degree so a detailed room tries only a few, each keeping the exact
// angle of its largest wall: fitting a rounded angle would tilt the bounds past a long wall
type Yaws = Map<number, { yaw: number; area: number }>;
function addYaw(yaws: Yaws, yaw: number, area: number) {
  const key = Math.round(THREE.MathUtils.radToDeg(yaw)) % 90;
  const known = yaws.get(key);
  if (!known || area > known.area) yaws.set(key, { yaw, area });
}

// The room's frame comes from its walls, wherever the rotation was authored (root, child mesh or
// baked into the vertices): of the wall-aligned yaws, the one with the smallest footprint wins
function orientedRoom(points: readonly THREE.Vector3[], yaws: Yaws): Room | null {
  if (points.length === 0) return null;
  let best: Room | null = null;
  let bestFootprint = Infinity;
  const local = new THREE.Vector3();
  for (const yaw of [0, ...[...yaws.values()].map((candidate) => candidate.yaw)]) {
    const toLocal = new THREE.Matrix4().makeRotationY(-yaw);
    const box = new THREE.Box3();
    for (const point of points) box.expandByPoint(local.copy(point).applyMatrix4(toLocal));
    const size = box.getSize(local);
    const footprint = size.x * size.z;
    if (footprint < bestFootprint - 1e-6) {
      bestFootprint = footprint;
      best = { box, toLocal, volume: size.x * size.y * size.z };
    }
  }
  return best;
}
type Chain = {
  lowpass: BiquadFilterNode;
  occlusion: GainNode;
  send: GainNode;
  nextCheck: number;
  // New sources snap to their occlusion instead of fading in from open
  fresh: boolean;
};

// Rooms are static while a preview runs; only the listener and sources move
export function createRoomAcoustics(listener: THREE.AudioListener) {
  const context = listener.context;
  const bus = context.createGain();
  const reverbs = REVERB_BUCKETS.map((bucket) => {
    const convolver = context.createConvolver();
    convolver.buffer = buildImpulse(context, bucket.seconds);
    const wet = context.createGain();
    wet.gain.value = 0;
    bus.connect(convolver);
    convolver.connect(wet);
    wet.connect(listener.getInput());
    return { convolver, wet };
  });
  const chains = new Map<THREE.PositionalAudio, Chain>();
  let rooms: Room[] = [];
  let walls: Wall[] = [];
  let props: readonly WalkProp[] = [];
  // Undefined until the first update so the opening reverb level snaps instead of fading
  let reverb: { room: Room | undefined; bucket: number; wet: number } | undefined;
  let nextFill = 0;
  let clock = 0;
  let stagger = 0;

  const listenerPosition = new THREE.Vector3();
  const localPoint = new THREE.Vector3();
  const sourcePosition = new THREE.Vector3();
  const segment = new THREE.Ray();
  const segmentBounds = new THREE.Box3();
  const hit = new THREE.Vector3();
  const normal = new THREE.Vector3();

  function roomAt(point: THREE.Vector3) {
    let best: Room | undefined;
    for (const room of rooms) {
      localPoint.copy(point).applyMatrix4(room.toLocal);
      if (room.box.containsPoint(localPoint) && (!best || room.volume < best.volume)) best = room;
    }
    return best;
  }
  function barriersBetween(from: THREE.Vector3, to: THREE.Vector3) {
    const length = from.distanceTo(to);
    if (length < 1e-4) return 0;
    segment.origin.copy(from);
    segment.direction.subVectors(to, from).divideScalar(length);
    segmentBounds.setFromPoints([from, to]);
    const distances: number[] = [];
    for (const { triangle, bounds } of walls) {
      if (!segmentBounds.intersectsBox(bounds)) continue;
      if (!segment.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) continue;
      const distance = hit.distanceTo(from);
      if (distance <= length) distances.push(distance);
    }
    distances.sort((a, b) => a - b);
    let barriers = 0;
    let last = -Infinity;
    for (const distance of distances) {
      if (distance - last > BARRIER_MERGE) barriers++;
      last = distance;
    }
    return barriers;
  }
  function apply(param: AudioParam, value: number, immediate: boolean) {
    if (immediate) {
      param.cancelScheduledValues(context.currentTime);
      param.value = value;
    } else param.setTargetAtTime(value, context.currentTime, SMOOTHING);
  }
  function occlude(sound: THREE.PositionalAudio, chain: Chain, immediate: boolean) {
    sound.getWorldPosition(sourcePosition);
    const target = occlusionFor(barriersBetween(listenerPosition, sourcePosition));
    apply(chain.occlusion.gain, target.gain, immediate);
    apply(chain.lowpass.frequency, target.cutoff, immediate);
    apply(chain.send.gain, BASE_SEND * target.send, immediate);
  }

  return {
    setRooms(next: readonly THREE.Object3D[]) {
      rooms = [];
      walls = [];
      for (const root of next) {
        root.updateWorldMatrix(true, true);
        const points: THREE.Vector3[] = [];
        const yaws: Yaws = new Map();
        root.traverseVisible((node) => {
          if (!(node instanceof THREE.Mesh)) return;
          const vertices = node.geometry.getAttribute("position");
          if (!vertices) return;
          const index = node.geometry.index;
          const meshPoints = Array.from({ length: vertices.count }, (_, i) =>
            new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(node.matrixWorld),
          );
          // One push per point: spreading a detailed mesh as arguments overflows the call stack
          for (const point of meshPoints) points.push(point);
          const vertex = (i: number) => meshPoints[index ? index.getX(i) : i]!;
          for (let i = 0; i + 2 < (index?.count ?? vertices.count); i += 3) {
            const triangle = new THREE.Triangle(vertex(i), vertex(i + 1), vertex(i + 2));
            // Floors and ceilings never separate rooms; skipping them keeps floor-level sources clear
            if (triangle.getArea() < 1e-8 || Math.abs(triangle.getNormal(normal).y) > 0.7) continue;
            addYaw(yaws, wallYaw(normal), triangle.getArea());
            walls.push({
              triangle,
              bounds: new THREE.Box3().setFromPoints([triangle.a, triangle.b, triangle.c]),
            });
          }
        });
        const room = orientedRoom(points, yaws);
        if (room) rooms.push(room);
      }
      reverb = undefined;
      for (const chain of chains.values()) chain.nextCheck = clock;
    },
    // Furniture may move or hide while a scene runs, so the listener's room is re-measured
    setProps(next: readonly WalkProp[]) {
      props = next;
      nextFill = clock;
    },
    attach(sound: THREE.PositionalAudio) {
      if (chains.has(sound)) return;
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = OPEN.cutoff;
      const occlusion = context.createGain();
      const send = context.createGain();
      send.gain.value = BASE_SEND;
      // Tap the send after Three's panner and volume gain, so the reverb fades with distance,
      // follows the source volume (0% is silent) and keeps the wall muffling of the dry path
      sound.gain.connect(send);
      send.connect(bus);
      sound.setFilters([lowpass, occlusion]);
      chains.set(sound, { lowpass, occlusion, send, nextCheck: clock, fresh: true });
    },
    detach(sound: THREE.PositionalAudio) {
      const chain = chains.get(sound);
      if (!chain) return;
      chains.delete(sound);
      sound.setFilters([]);
      sound.gain.disconnect(chain.send);
      chain.lowpass.disconnect();
      chain.occlusion.disconnect();
      chain.send.disconnect();
    },
    update(delta: number) {
      clock += delta;
      listener.getWorldPosition(listenerPosition);
      const room = roomAt(listenerPosition);
      if (!reverb || room !== reverb.room || clock >= nextFill) {
        nextFill = clock + FILL_INTERVAL;
        const target = room
          ? reverbFor(room.volume, roomEmptiness(room.box, props, room.toLocal))
          : { bucket: -1, wet: 0 };
        const first = !reverb;
        if (
          first ||
          target.bucket !== reverb!.bucket ||
          Math.abs(target.wet - reverb!.wet) > 0.01
        ) {
          reverbs.forEach(({ wet }, i) => {
            const level = i === target.bucket ? target.wet : 0;
            if (first) wet.gain.value = level;
            else wet.gain.setTargetAtTime(level, context.currentTime, ROOM_FADE);
          });
          reverb = { room, ...target };
        } else reverb!.room = room;
      }
      for (const [sound, chain] of chains) {
        if (clock < chain.nextCheck) continue;
        const immediate = chain.fresh;
        chain.fresh = false;
        // Spread raycasts across frames so many sources do not land on one
        chain.nextCheck = clock + OCCLUSION_INTERVAL + (stagger++ % 5) * 0.01;
        occlude(sound, chain, immediate);
      }
    },
    dispose() {
      for (const sound of [...chains.keys()]) this.detach(sound);
      for (const { convolver, wet } of reverbs) {
        convolver.disconnect();
        wet.disconnect();
      }
      bus.disconnect();
      rooms = [];
      walls = [];
      props = [];
    },
  };
}
