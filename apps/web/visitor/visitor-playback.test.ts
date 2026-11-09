import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createVisitorPlayback } from "./visitor-playback";
const resume = vi.hoisted(() => vi.fn<() => Promise<void>>());
beforeEach(() => resume.mockReset().mockResolvedValue());

vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return {
    ...actual,
    AudioListener: class extends actual.Object3D {
      context = { resume };
      gain = { disconnect() {} };
    },
  };
});

it("clears a rejected audio-context resume only after the context recovers", async () => {
  const { runtime, report } = fixture(0);
  resume.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
  runtime.start();
  await vi.waitFor(() =>
    expect(report).toHaveBeenLastCalledWith("Select Enable audio to allow playback"),
  );
  runtime.start();
  await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("Exhibition ready"));
  runtime.dispose();
});

it("does not publish a late recovery status after the visit is disposed", async () => {
  const { runtime, nodes, report } = fixture();
  runtime.begin();
  await vi.waitFor(() => expect(report).toHaveBeenCalled());
  let resolve!: () => void;
  nodes[0]!.play.mockReturnValueOnce(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  runtime.start();
  runtime.dispose();
  report.mockClear();
  resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(report).not.toHaveBeenCalled();
});
afterEach(() => vi.unstubAllGlobals());

function fixture(count = 1) {
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  const nodes = Array.from({ length: count }, (_, index) => ({
    readyState: 4,
    paused: true,
    ended: false,
    currentTime: 0,
    play: vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError")),
    pause: vi.fn(),
    closest: (selector: string) =>
      selector === "[hidden]" ? null : { dataset: { componentId: String(index) } },
  }));
  const panels = nodes.map((node, index) => ({
    dataset: { componentId: String(index) },
    querySelector: () => node,
  }));
  const content = Object.assign(new EventTarget(), {
    querySelectorAll: (selector: string) =>
      selector === "[data-component-id]"
        ? panels
        : selector === "audio[data-spatial-owner]"
          ? []
          : nodes,
  });
  const report = vi.fn();
  const runtime = createVisitorPlayback(
    {
      id: "scene",
      name: "Test scene",
      environmentAssetId: null,
      startCamera: { position: [0, 0, 5], rotation: [0, 0, 0, 1], fovDegrees: 40 },
      objects: [],
      interactions: [],
      hotspots: [],
    },
    new THREE.PerspectiveCamera(),
    { target: new THREE.Vector3(), update() {} },
    new Map(),
    content as unknown as HTMLElement,
    vi.fn(),
    report,
  );
  return { runtime, nodes, report };
}

it("clears the permission warning when a blocked track succeeds after Enable audio", async () => {
  const { runtime, nodes, report } = fixture();
  runtime.begin();
  await vi.waitFor(() =>
    expect(report).toHaveBeenLastCalledWith("Select Enable audio to allow playback"),
  );
  nodes[0]!.play.mockResolvedValueOnce();
  runtime.start();
  await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("Exhibition ready"));
  expect(nodes[0]!.play).toHaveBeenCalledTimes(2);
  runtime.dispose();
});

it("keeps the warning until every blocked track has recovered", async () => {
  const { runtime, nodes, report } = fixture(2);
  runtime.begin();
  await vi.waitFor(() => expect(report).toHaveBeenCalled());
  nodes[0]!.play.mockResolvedValueOnce();
  nodes[1]!.play.mockRejectedValueOnce(new DOMException("Still blocked", "NotAllowedError"));
  runtime.start();
  await vi.waitFor(() => expect(nodes[1]!.play).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  await Promise.resolve();
  expect(report).toHaveBeenLastCalledWith("Select Enable audio to allow playback");
  nodes[1]!.play.mockResolvedValueOnce();
  runtime.start();
  await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("Exhibition ready"));
  runtime.dispose();
});
