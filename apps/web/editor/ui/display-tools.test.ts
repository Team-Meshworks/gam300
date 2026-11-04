import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { displayCaseTools, displayPanelTools } from "./display-tools";
import { Icon } from "./Icon";
import horizontalStandSvg from "./assets/horizontal-stand.svg?raw";
import verticalStandSvg from "./assets/vertical-stand.svg?raw";
import verticalPanelSvg from "./assets/vertical-panel.svg?raw";
import horizontalPanelSvg from "./assets/horizontal-panel.svg?raw";
import cubeDisplayCaseSvg from "./assets/cube-display-case.svg?raw";
import clearCubeDisplayCaseSvg from "./assets/clear-cube-display-case.svg?raw";
import clearCuboidDisplayCaseSvg from "./assets/clear-cuboid-display-case.svg?raw";
import cuboidDisplayCaseSvg from "./assets/cuboid-display-case.svg?raw";

describe("stand and display toolbar mappings", () => {
  it("offers all eight supplied assets exactly once in their own tray", () => {
    const all = [...displayPanelTools, ...displayCaseTools];
    expect(new Set(all.map((tool) => tool.assetId)).size).toBe(8);
    expect(displayPanelTools).toHaveLength(4);
    expect(displayCaseTools).toHaveLength(4);
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
  it("uses the exact exported SVG files through the shared Icon component", () => {
    const tools = [...displayPanelTools, ...displayCaseTools];
    const icons = tools.map((tool) =>
      renderToStaticMarkup(createElement(Icon, { name: tool.icon })),
    );
    expect(new Set(icons).size).toBe(8);
    const files = [
      "horizontal-stand.svg",
      "vertical-stand.svg",
      "vertical-panel.svg",
      "horizontal-panel.svg",
      "cube-display-case.svg",
      "clear-cube-display-case.svg",
      "clear-cuboid-display-case.svg",
      "cuboid-display-case.svg",
    ];
    const sources = [
      horizontalStandSvg,
      verticalStandSvg,
      verticalPanelSvg,
      horizontalPanelSvg,
      cubeDisplayCaseSvg,
      clearCubeDisplayCaseSvg,
      clearCuboidDisplayCaseSvg,
      cuboidDisplayCaseSvg,
    ];
    for (const [index, icon] of icons.entries()) {
      expect(icon).toContain('<img class="figma-tool-icon"');
      expect(icon).toContain(files[index]);
      expect(icon).toContain('width="40" height="40"');
      expect(icon).toContain('alt=""');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('draggable="false"');
      expect(icon).not.toContain("<svg");
      expect(icon).not.toContain("figma.com");
      const source = sources[index]!;
      expect(source).toContain('<svg width="40" height="40"');
      const viewBox = source
        .match(/viewBox="([^"]+)"/)![1]!
        .split(" ")
        .map(Number);
      expect(viewBox.slice(2)).toEqual([40, 40]);
      expect(source).toContain('fill="#3D3133" fill-opacity="0.5" stroke="#3D3133"');
      expect(source).not.toContain("<image");
    }
  });
});
