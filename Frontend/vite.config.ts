import { defineConfig } from "vite";

// Deliberately framework-free: the frontend owner picks the UI stack.
export default defineConfig({
  build: {
    outDir: "dist",
  },
});
