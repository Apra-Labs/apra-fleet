import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The apra-fleet server is expected to serve the built shell under /ui/, so
// asset URLs must be relative to that base -- never a hardcoded host/port.
export default defineConfig({
  base: "/ui/",
  plugins: [react()]
});
