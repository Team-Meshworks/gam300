import { afterEach, describe, expect, it, vi } from "vitest";
import { runAction } from "./actionHandler";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeAudio.latest = undefined;
});

describe("action handler", () => {
  it("opens a link in a new tab", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    runAction({
      type: "open-link",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(open).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("plays audio from the action URL", () => {
    vi.stubGlobal("Audio", FakeAudio);

    runAction({ type: "play-audio", url: "/audio/ding.wav" });

    expect(FakeAudio.latest?.src).toBe("/audio/ding.wav");
    expect(FakeAudio.latest?.play).toHaveBeenCalledOnce();
  });

  it("stops the previous audio before playing another", () => {
    vi.stubGlobal("Audio", FakeAudio);

    runAction({ type: "play-audio", url: "/audio/ding.wav" });
    const first = FakeAudio.latest;
    runAction({ type: "play-audio", url: "/audio/ding.wav" });

    expect(first?.pause).toHaveBeenCalledOnce();
  });

  it("shows a hi alert", () => {
    const alert = vi.fn();
    vi.stubGlobal("window", { alert });

    runAction({ type: "print-hi" });

    expect(alert).toHaveBeenCalledExactlyOnceWith("hi");
  });

  it("does nothing when a URL is missing", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.stubGlobal("Audio", FakeAudio);

    runAction({ type: "open-link" });
    runAction({ type: "play-audio" });

    expect(open).not.toHaveBeenCalled();
    expect(FakeAudio.latest).toBeUndefined();
  });
});
