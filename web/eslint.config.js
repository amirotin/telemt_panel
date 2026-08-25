import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Minimal config: typescript-eslint recommended + react-hooks + fast-refresh
// sanity. No Prettier — gofmt-style "one command, no bikeshedding" applies
// to the frontend too (see CLAUDE.md conventions).
export default tseslint.config(
  // "dist" doesn't exist under web/ (vite.config.ts's outDir is
  // ../internal/webui/dist — outside this project root, see that file's
  // comment) but is harmless to keep listed in case that ever changes.
  // src/lib/api/generated is hey-api's committed codegen output — not
  // hand-written, not linted.
  { ignores: ["dist", "src/lib/api/generated"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Toast.tsx exports its store's imperative API (pushToast/
      // dismissToast) alongside ToastViewport by design (see that file's
      // own comment) — allowed by name rather than split into two files.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true, allowExportNames: ["pushToast", "dismissToast"] },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // TanStack Router's file-based routes define their component locally
    // and export only `Route` (createFileRoute(...).component wraps it) —
    // this rule has no escape hatch for that shape (allowExportNames only
    // covers the export itself, not a same-file unexported local
    // component), so routes/ is exempt rather than fighting the
    // framework's convention.
    files: ["src/routes/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
