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
      targetObjectId: "crate",
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

    runAction({ type: "play-audio", targetObjectId: "crate", url: "/audio/ding.wav" });

    expect(FakeAudio.latest?.src).toBe("/audio/ding.wav");
    expect(FakeAudio.latest?.play).toHaveBeenCalledOnce();
  });

  it("stops the previous audio before playing another", () => {
    vi.stubGlobal("Audio", FakeAudio);

    runAction({ type: "play-audio", targetObjectId: "crate", url: "/audio/ding.wav" });
    const first = FakeAudio.latest;
    runAction({ type: "play-audio", targetObjectId: "crate", url: "/audio/ding.wav" });

    expect(first?.pause).toHaveBeenCalledOnce();
  });

  it("prints hi", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    runAction({ type: "print-hi", targetObjectId: "crate" });

    expect(log).toHaveBeenCalledExactlyOnceWith("hi");
  });

  it("does nothing when a URL is missing", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.stubGlobal("Audio", FakeAudio);

    runAction({ type: "open-link", targetObjectId: "crate" });
    runAction({ type: "play-audio", targetObjectId: "crate" });

    expect(open).not.toHaveBeenCalled();
    expect(FakeAudio.latest).toBeUndefined();
  });
});
