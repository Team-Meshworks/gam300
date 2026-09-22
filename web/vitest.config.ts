import { defineConfig } from "vitest/config";

// Tests also live in shared, outside the editor's Vite root
export default defineConfig({
  test: {
    environment: "node",
    include: ["shared/**/*.test.ts", "editor/**/*.test.ts"],
  },
});
