import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createVisitorPlayback } from "./visitor-playback";
import type { ProjectRule } from "../shared/project/project-content";
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

function fixture(count = 1, rules: readonly ProjectRule[] = []) {
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  const owners = Array.from({ length: count }, (_, index) => ({
    dataset: { ownerId: `owner-${index}` },
    hidden: false,
    querySelectorAll: () => [nodes[index]!],
  }));
  const nodes = Array.from({ length: count }, (_, index) => ({
    readyState: 4,
    paused: true,
    ended: false,
    currentTime: 0,
    play: vi
      .fn<() => Promise<void>>()
      .mockResolvedValue()
      .mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError")),
    pause: vi.fn(),
    closest: (selector: string) =>
      selector === "[hidden]"
        ? owners[index]!.hidden
          ? owners[index]
          : null
        : { dataset: { componentId: String(index) } },
  }));
  const panels = nodes.map((node, index) => ({
    dataset: { componentId: String(index) },
    querySelector: () => node,
  }));
  const content = Object.assign(new EventTarget(), {
    querySelectorAll: (selector: string) =>
      selector === "[data-component-id]"
        ? panels
        : selector === "[data-owner-id]"
          ? owners
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
      groups: [],
      zones: [],
      viewpoints: [],
      rules,
    },
    new THREE.PerspectiveCamera(),
    { target: new THREE.Vector3(), update() {} },
    new Map(),
    content as unknown as HTMLElement,
    vi.fn(() => true),
    report,
    vi.fn(),
  );
  return { runtime, nodes, owners, panels, report };
}

function visibilityRule(seconds: number, visible: boolean): ProjectRule {
  return {
    id: `visibility-${seconds}`,
    enabled: true,
    trigger: { type: "elapsed", seconds },
    actions: [{ type: "setVisible", objectId: "OWNER-0", visible }],
  };
}

it("discards a hidden owner's blocked track while retaining other blocked tracks", async () => {
  const { runtime, nodes, owners, report } = fixture(2, [visibilityRule(1, false)]);
  runtime.begin();
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
  runtime.update(1);
  expect(owners[0]!.hidden).toBe(true);
  expect(nodes[0]!.pause).toHaveBeenCalledOnce();
  expect(report).toHaveBeenLastCalledWith("Select Enable audio to allow playback");
  runtime.start();
  await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("Exhibition ready"));
  runtime.start();
  expect(nodes[0]!.play).toHaveBeenCalledOnce();
  expect(nodes[1]!.play).toHaveBeenCalledTimes(2);
  runtime.dispose();
});

it("clears the warning immediately when a rule hides the last blocked owner", async () => {
  const { runtime, report } = fixture(1, [visibilityRule(1, false)]);
  runtime.begin();
  await vi.waitFor(() =>
    expect(report).toHaveBeenLastCalledWith("Select Enable audio to allow playback"),
  );
  runtime.update(1);
  expect(report).toHaveBeenLastCalledWith("Exhibition ready");
  runtime.dispose();
});

it.each([false, true])(
  "ignores a late rejection from a hidden request (shown again: %s)",
  async (showAgain) => {
    const { runtime, nodes, owners, report } = fixture(2, [
      visibilityRule(1, false),
      ...(showAgain ? [visibilityRule(2, true)] : []),
    ]);
    let reject!: (reason: Error) => void;
    nodes[0]!.play.mockReset().mockReturnValueOnce(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    runtime.begin();
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(nodes[0]!.play).toHaveBeenCalledOnce();
    runtime.update(1);
    expect(owners[0]!.hidden).toBe(true);
    runtime.start();
    await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("Exhibition ready"));
    if (showAgain) runtime.update(1);
    report.mockClear();
    reject(new DOMException("Interrupted playback", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
    runtime.start();
    expect(nodes[0]!.play).toHaveBeenCalledOnce();
    runtime.dispose();
  },
);

it("clears a blocked request when its component no longer exists", async () => {
  const { runtime, nodes, panels, report } = fixture();
  runtime.begin();
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  panels.splice(0);
  runtime.start();
  await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("Exhibition ready"));
  expect(nodes[0]!.play).toHaveBeenCalledOnce();
  runtime.dispose();
});

it("allows a fresh play action after showing an owner without restoring its old rejection", async () => {
  const show = visibilityRule(2, true);
  const { runtime, nodes, report } = fixture(1, [
    visibilityRule(1, false),
    { ...show, actions: [...show.actions, { type: "playMedia", mediaId: "0" }] },
  ]);
  let reject!: (reason: Error) => void;
  nodes[0]!.play
    .mockReset()
    .mockResolvedValue()
    .mockReturnValueOnce(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
  runtime.begin();
  expect(nodes[0]!.play).toHaveBeenCalledOnce();
  runtime.update(1);
  runtime.update(1);
  expect(nodes[0]!.play).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  reject(new DOMException("Old request interrupted", "AbortError"));
  await Promise.resolve();
  await Promise.resolve();
  expect(report).not.toHaveBeenCalledWith("Select Enable audio to allow playback");
  runtime.start();
  expect(nodes[0]!.play).toHaveBeenCalledTimes(2);
  runtime.dispose();
});

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
