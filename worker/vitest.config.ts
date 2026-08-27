import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // createTestHarness() が実際に workerd を起動するため、通常のユニットテストより余裕を持たせる。
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
