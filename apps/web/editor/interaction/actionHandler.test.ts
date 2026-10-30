import { afterEach, describe, expect, it, vi } from "vitest";
import { runAction, stopActiveAudio } from "./actionHandler";

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
  stopActiveAudio();
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

    runAction({ type: "open-link", url });

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

    runAction({ type: "open-link", url: "https://[" });

    expect(createElement).not.toHaveBeenCalled();
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

  it("stops active audio once when the preview resets", () => {
    vi.stubGlobal("Audio", FakeAudio);
    runAction({ type: "play-audio", url: "/audio/ding.wav" });
    const audio = FakeAudio.latest;

    stopActiveAudio();
    stopActiveAudio();

    expect(audio?.pause).toHaveBeenCalledOnce();
  });

  it("shows a hi alert", () => {
    const alert = vi.fn();
    vi.stubGlobal("window", { alert });

    runAction({ type: "print-hi" });

    expect(alert).toHaveBeenCalledExactlyOnceWith("hi");
  });

  it("does nothing when a URL is missing", () => {
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal("Audio", FakeAudio);

    runAction({ type: "open-link" });
    runAction({ type: "play-audio" });

    expect(createElement).not.toHaveBeenCalled();
    expect(FakeAudio.latest).toBeUndefined();
  });
});
