import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Project-local vitest config for the shell-ui package, wired into the root
// vitest.config.ts via test.projects so it runs as part of the same `vitest
// run` invocation the bounded runner (scripts/run-all-tests.mjs) already
// spawns -- no new suite entry needed there. React component tests need a
// DOM (jsdom), unlike the root project's node environment used for the rest
// of the repo's tests.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "apra-fleet-shell-ui",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"]
  }
});
