import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { displayCaseTools, displayPanelTools } from "./display-tools";
import { Icon } from "./Icon";

describe("stand and display toolbar mappings", () => {
  it("offers all seven supplied assets exactly once in their own tray", () => {
    const all = [...displayPanelTools, ...displayCaseTools];
    expect(new Set(all.map((tool) => tool.assetId)).size).toBe(7);
    expect(displayPanelTools).toHaveLength(3);
    expect(displayCaseTools).toHaveLength(4);
    expect(displayPanelTools.map((tool) => tool.assetId)).toEqual([
      "display-rectangle-stand-v1",
      "display-square-stand-v1",
      "display-rectangle-panel-v1",
    ]);
    expect(displayCaseTools.map((tool) => tool.assetId)).toEqual([
      "display-cube-v1",
      "display-half-glass-case-v1",
      "display-full-glass-case-v1",
      "display-one-sided-glass-case-v1",
    ]);
  });
  it("uses distinct real SVG silhouettes through the shared Icon component", () => {
    const tools = [...displayPanelTools, ...displayCaseTools];
    const icons = tools.map((tool) =>
      renderToStaticMarkup(createElement(Icon, { name: tool.icon })),
    );
    expect(new Set(icons).size).toBe(7);
    for (const icon of icons) {
      expect(icon).toContain('class="icon"');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain("currentColor");
    }
  });
});
