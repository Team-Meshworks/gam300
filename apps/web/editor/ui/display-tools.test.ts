import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { displayCaseTools, displayPanelTools } from "./display-tools";
import { Icon } from "./Icon";

describe("stand and display toolbar mappings", () => {
  it("offers all eight supplied assets exactly once in their own tray", () => {
    expect(displayPanelTools.map((tool) => tool.assetId)).toEqual([
      "display-rectangle-stand-v1",
      "display-square-stand-v1",
      "display-square-panel-v1",
      "display-rectangle-panel-v1",
    ]);
    expect(displayCaseTools.map((tool) => tool.assetId)).toEqual([
      "display-cube-v1",
      "display-half-glass-case-v1",
      "display-full-glass-case-v1",
      "display-one-sided-glass-case-v1",
    ]);
  });
  it("renders the mapped toolbar icons as decorative, non-draggable images", () => {
    const tools = [...displayPanelTools, ...displayCaseTools];
    const icons = [...tools.map((tool) => tool.icon), "savedView" as const].map((name) =>
      renderToStaticMarkup(createElement(Icon, { name })),
    );
    const files = [
      "horizontal-stand.svg",
      "vertical-stand.svg",
      "vertical-panel.svg",
      "horizontal-panel.svg",
      "cube-display-case.svg",
      "clear-cube-display-case.svg",
      "clear-cuboid-display-case.svg",
      "cuboid-display-case.svg",
      "saved-views.svg",
    ];
    for (const [index, icon] of icons.entries()) {
      expect(icon).toContain("<img");
      expect(icon).toContain(files[index]);
      expect(icon).toContain('alt=""');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('draggable="false"');
    }
  });
});
