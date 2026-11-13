import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { PublicationShare } from "./PublicationShare";

describe("publication sharing", () => {
  it("shows the committed link and an accessible QR code", () => {
    const url = "https://spatia.example/p/22222222-2222-4222-8222-222222222222";
    const markup = renderToStaticMarkup(createElement(PublicationShare, { url }));
    expect(markup).toContain(`value="${url}"`);
    expect(markup).toMatch(/role="img"[^>]*aria-label="[^"]*QR code/i);
    expect(markup).toContain("Copy link");
  });

  it.each([
    "https://spatia.example/p/22222222-2222-4222-8222-222222222222",
    `https://${"a".repeat(63)}.${"b".repeat(63)}.example/p/22222222-2222-4222-8222-222222222222`,
  ])("encodes the exact publication URL in a decodable QR: %s", (url) => {
    const markup = renderToStaticMarkup(createElement(PublicationShare, { url }));
    const size = Number(markup.match(/viewBox="0 0 (\d+) \d+"/)?.[1]);
    const path = markup.match(/<path fill="#000000" d="([^"]+)"/)?.[1];
    expect(size).toBeGreaterThan(0);
    expect(path).toBeDefined();
    const scale = 6;
    const width = size * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    const runs = [...(path ?? "").matchAll(/M(\d+)[ ,](\d+)\s*h(\d+)v1H\d+z/g)];
    expect(runs.length).toBeGreaterThan(0);
    for (const [, rawX, rawY, rawLength] of runs) {
      const x = Number(rawX) * scale;
      const y = Number(rawY) * scale;
      const length = Number(rawLength) * scale;
      for (let row = y; row < y + scale; row++) {
        for (let column = x; column < x + length; column++) {
          const offset = (row * width + column) * 4;
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
        }
      }
    }
    expect(jsQR(pixels, width, width)?.data).toBe(url);
  });
});

// Pending reads cannot display an approval claim before the server confirms it.
it("keeps unverified publication requirements neutral", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PublishStatus } = await import("./PublishStatus");
  const html = renderToStaticMarkup(
    createElement(PublishStatus, {
      state: "checking",
      titleId: "status",
      closeLabel: "Close",
      onClose: () => {},
      actions: null,
    }),
  );
  expect(html).toContain("Checking saved revision");
  expect(html).not.toContain("Teacher-approved");
  expect(html).not.toContain("Both requirements met");
  expect(html).not.toContain("Publishing requirements");
});
