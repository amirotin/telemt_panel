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
      // Same pattern for display-mode's/realtime's context+hooks modules
      // (Task 4): a context module exporting its Provider component
      // alongside the hooks that read it is the whole point of keeping
      // them colocated, not something worth a file split.
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: [
            "pushToast",
            "dismissToast",
            "useDisplayMode",
            "useTopic",
            "useSnapshot",
            "useConnectionState",
            "useRefreshTopic",
            "resetSSEClient",
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The UI is bilingual (D3): reading `ru` outside i18n/ pins a string
      // to Russian forever — exactly the mixed-language screen 06-ui.md
      // forbids, and one that type-checks and renders fine in Russian, so
      // nothing else catches it. Components read `useStrings()`; helpers
      // take an `s: Dict` parameter. Tests are exempt below.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/i18n",
              importNames: ["ru", "en"],
              message:
                "Read UI strings through useStrings() (components) or an `s: Dict` parameter (helpers) — importing a dictionary directly freezes the string to one language.",
            },
          ],
          patterns: [
            {
              group: ["**/i18n", "**/i18n/ru", "**/i18n/en"],
              importNames: ["ru", "en"],
              message:
                "Read UI strings through useStrings() (components) or an `s: Dict` parameter (helpers) — importing a dictionary directly freezes the string to one language.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tests and the i18n module itself legitimately name the dictionaries:
    // a test pins the language it asserts against, and i18n/ is where they
    // are defined, typed and compared.
    files: ["src/i18n/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
  {
    // e2e/ (Playwright, Task 9) isn't React code — its fixtures.ts extends
    // @playwright/test's own `test` with a fixture whose second parameter
    // Playwright's API requires to be literally named `use` (the fixture
    // callback signature), which eslint-plugin-react-hooks' naming-based
    // detection mistakes for React's own `use()` hook, flagging the
    // enclosing (non-component, non-hook) fixture function.
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-refresh/only-export-components": "off",
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
