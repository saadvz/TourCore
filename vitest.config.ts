import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live-app tests make many webhook round trips. The 5s default killed
    // "holds the question, opens a flag with no draft, and still answers rent"
    // on the GitHub runner while the rest of the suite passed.
    testTimeout: 20_000,
    exclude: [...configDefaults.exclude, "test/eval/**", "**/.cursor/**"],
  },
});
