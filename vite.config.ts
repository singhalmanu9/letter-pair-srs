/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the build works both as a project page
  // (user.github.io/letter-pair-srs/) and at a domain root.
  base: "./",
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
