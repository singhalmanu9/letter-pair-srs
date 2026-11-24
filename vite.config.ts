/// <reference types="vitest" />
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // "/" locally; the GitHub Pages workflow sets BASE_PATH (e.g. "/letter-pair-srs/").
  base: process.env.BASE_PATH ?? "/",
  plugins: [
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        // Placeholder icons; to be replaced with the final ones.
        name: "BLD Letter Pairs SRS",
        short_name: "BLD Pairs",
        description: "Spaced repetition for blindfolded cubing letter pairs.",
        theme_color: "#111827",
        background_color: "#111827",
        display: "standalone",
        orientation: "portrait",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: { globPatterns: ["**/*.{js,css,html,svg,png}"] },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
