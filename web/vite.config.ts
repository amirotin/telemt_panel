import { writeFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// emptyOutDir wipes internal/webui/dist/.gitkeep along with everything else
// on every build — restore it so `git status` doesn't show it as deleted
// after a routine local `npm run build`/`make web` (it stays gitignored
// everywhere else via internal/webui/dist/*, see .gitignore, so this is the
// only file this plugin needs to touch).
function restoreDistGitkeep(): Plugin {
  return {
    name: "restore-dist-gitkeep",
    closeBundle() {
      writeFileSync(new URL("../internal/webui/dist/.gitkeep", import.meta.url), "");
    },
  };
}

// base: "./" — assets are referenced relative to index.html itself, so the
// same build works unmodified whether internal/webui serves it at "/" or
// under a configured base_path prefix ("/panel/"). Go only has to inject
// window.__BASE_PATH__ into index.html at serve time (see
// internal/webui); it never has to rewrite asset URLs.
export default defineConfig({
  base: "./",
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    restoreDistGitkeep(),
  ],
  build: {
    // Builds straight into the Go package that embeds it — no v0-style
    // copy/symlink step between `npm run build` and `go:embed`. See
    // internal/webui/embed.go.
    outDir: "../internal/webui/dist",
    emptyOutDir: true,
    // Content-hashed filenames for JS/CSS enable the immutable cache
    // header internal/webui sets for everything under assets/.
    assetsDir: "assets",
  },
  server: {
    proxy: {
      // Dev proxy: panel backend runs separately (`make dev-backend`,
      // default :8080). changeOrigin so the panel sees a same-origin
      // request; ws:true + no buffering so /api/events (SSE) streams
      // instead of arriving in one chunk after the connection closes.
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        ws: true,
      },
      "/sub": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    css: true,
    setupFiles: ["./src/testSetup.ts"],
    // e2e/ (Task 9, Playwright — playwright.config.ts) matches vitest's
    // own default *.spec.ts discovery pattern; those specs use
    // @playwright/test's own `test`/`expect`, not vitest's, and must only
    // ever run through `npm run e2e`.
    exclude: ["node_modules/**", "e2e/**"],
  },
});
