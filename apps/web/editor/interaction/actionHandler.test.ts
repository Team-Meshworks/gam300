import { afterEach, expect, it, vi } from "vitest";
import { createActionRunner } from "./actionHandler";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("opens a link in a new tab and releases the anchor", () => {
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const clicked: HTMLAnchorElement[] = [];
  document.body.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof HTMLAnchorElement)) return;
      event.preventDefault();
      clicked.push(event.target);
    },
    { once: true },
  );

  createActionRunner().run({ type: "open-link", url });

  expect(clicked).toHaveLength(1);
  expect(clicked[0]).toMatchObject({
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    isConnected: false,
  });
});

it.each(["https://[", undefined])("does not open an invalid or missing link (%s)", (url) => {
  const createElement = vi.spyOn(document, "createElement");
  const runner = createActionRunner();

  runner.run(url ? { type: "open-link", url } : { type: "open-link" });

  expect(createElement).not.toHaveBeenCalled();
});

it("does not create audio when its URL or linked track is missing", () => {
  const Audio = vi.spyOn(window, "Audio");
  const runner = createActionRunner();

  runner.run({ type: "play-audio" });
  runner.run({ type: "play-audio", mediaId: "missing" });

  expect(Audio).not.toHaveBeenCalled();
});
