import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionRunner, type ActionRunner } from "./actionHandler";

class FakeAudio {
  static latest: FakeAudio | undefined;
  readonly src: string;
  readonly pause = vi.fn();
  readonly play = vi.fn(() => Promise.resolve());

  constructor(src: string) {
    this.src = src;
    FakeAudio.latest = this;
  }
}

let runner: ActionRunner;

beforeEach(() => {
  runner = createActionRunner();
});

afterEach(() => {
  runner.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeAudio.latest = undefined;
});

describe("action handler", () => {
  it("opens a link in a new tab", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const click = vi.fn();
    const remove = vi.fn();
    const link = { href: "", target: "", rel: "", click, remove };
    const append = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => link),
      body: { append },
    });

    runner.run({ type: "open-link", url });

    expect(document.createElement).toHaveBeenCalledWith("a");
    expect(link.href).toBe(url);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(append).toHaveBeenCalledWith(link);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("does not open an invalid link", () => {
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });

    runner.run({ type: "open-link", url: "https://[" });

    expect(createElement).not.toHaveBeenCalled();
  });

  it("plays audio from the action URL", () => {
    vi.stubGlobal("Audio", FakeAudio);

    runner.run({ type: "play-audio", url: "/audio/ding.wav" });

    expect(FakeAudio.latest?.src).toBe("/audio/ding.wav");
    expect(FakeAudio.latest?.play).toHaveBeenCalledOnce();
  });

  it("stops the previous audio before playing another", () => {
    vi.stubGlobal("Audio", FakeAudio);

    runner.run({ type: "play-audio", url: "/audio/ding.wav" });
    const first = FakeAudio.latest;
    runner.run({ type: "play-audio", url: "/audio/ding.wav" });

    expect(first?.pause).toHaveBeenCalledOnce();
  });

  it("stops active audio once when the preview resets", () => {
    vi.stubGlobal("Audio", FakeAudio);
    runner.run({ type: "play-audio", url: "/audio/ding.wav" });
    const audio = FakeAudio.latest;

    runner.stop();
    runner.stop();

    expect(audio?.pause).toHaveBeenCalledOnce();
  });

  it("keeps each runner's playback separate", () => {
    vi.stubGlobal("Audio", FakeAudio);
    const other = createActionRunner();
    runner.run({ type: "play-audio", url: "/audio/ding.wav" });
    const audio = FakeAudio.latest;

    other.stop();

    expect(audio?.pause).not.toHaveBeenCalled();
  });

  it("shows a hi alert", () => {
    const alert = vi.fn();
    vi.stubGlobal("window", { alert });

    runner.run({ type: "print-hi" });

    expect(alert).toHaveBeenCalledExactlyOnceWith("hi");
  });

  it("does nothing when a URL is missing", () => {
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal("Audio", FakeAudio);

    runner.run({ type: "open-link" });
    runner.run({ type: "play-audio" });

    expect(createElement).not.toHaveBeenCalled();
    expect(FakeAudio.latest).toBeUndefined();
  });
});

it("resolves the current scene track by ID and stops playback when preview ends", () => {
  vi.stubGlobal("Audio", FakeAudio);
  const spatial = vi.fn();
  const resolve = vi.fn((id: string) =>
    id === "track"
      ? { url: "/media/bgm.m4a", loop: true, volume: 0.4 }
      : id === "spatial"
        ? { url: "/media/sound.m4a", loop: false, volume: 1, play: spatial }
        : undefined,
  );
  const player = createActionRunner(undefined, resolve);
  player.run({ type: "play-audio", mediaId: "missing" });
  expect(FakeAudio.latest).toBeUndefined();
  player.run({ type: "play-audio", mediaId: "track" });
  expect(FakeAudio.latest).toMatchObject({ src: "/media/bgm.m4a", loop: true, volume: 0.4 });
  expect(FakeAudio.latest!.play).toHaveBeenCalledOnce();
  player.stop();
  expect(FakeAudio.latest!.pause).toHaveBeenCalledOnce();
  player.run({ type: "play-audio", mediaId: "spatial" });
  expect(spatial).toHaveBeenCalledOnce();
  expect(FakeAudio.latest?.src).toBe("/media/bgm.m4a");
});

it("does not restart an already-playing linked track on repeated hotspot clicks", () => {
  vi.stubGlobal("Audio", FakeAudio);
  const player = createActionRunner(undefined, () => ({
    url: "/media/bgm.m4a",
    loop: true,
    volume: 1,
  }));
  player.run({ type: "play-audio", mediaId: "track" });
  const first = FakeAudio.latest!;
  player.run({ type: "play-audio", mediaId: "track" });
  expect(FakeAudio.latest).toBe(first);
  expect(first.play).toHaveBeenCalledOnce();
  expect(first.pause).not.toHaveBeenCalled();
  player.stop();
});
