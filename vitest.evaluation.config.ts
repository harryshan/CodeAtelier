import { defineConfig } from "vitest/config";

// Opt-in only: this suite is excluded from the default test/check commands.
export default defineConfig({
  test: { include: ["evals/**/*.test.ts"], testTimeout: 15000 },
});
