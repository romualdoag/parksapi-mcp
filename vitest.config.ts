import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our suite — never upstream/'s 100+ park tests.
    include: ["tests/**/*.test.ts"],
    testTimeout: 150_000,
    hookTimeout: 30_000,
  },
});
