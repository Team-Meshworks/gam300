import { defineConfig } from "vitest/config";

const domTests = [
  "editor/controls/fpsControls.test.ts",
  "editor/ui/blocked-storage.test.ts",
  "editor/graphics/display-content.test.ts",
  "editor/graphics/modeManager.test.ts",
  "editor/interaction/actionHandler.test.ts",
  "shared/asset-runtime/ModelCache.test.ts",
  "shared/preview/fps-walk-space.test.ts",
  "shared/preview/mobile-controls.test.ts",
  "visitor/visitor-playback.test.ts",
];

// Tests also live in shared, outside the editor's Vite root
export default defineConfig({
  test: {
    environment: "node",
    execArgv: ["--experimental-webstorage", "--localstorage-file=:memory:"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["shared/**/*.test.ts", "editor/**/*.test.ts", "visitor/**/*.test.ts"],
          exclude: domTests,
        },
      },
      { extends: true, test: { name: "dom", environment: "jsdom", include: domTests } },
    ],
  },
});
