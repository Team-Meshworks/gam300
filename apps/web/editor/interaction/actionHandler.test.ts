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
