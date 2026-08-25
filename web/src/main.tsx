import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import "./lib/api/client";
import { queryClient } from "./lib/query-client";
import { getBasePath } from "./lib/base-path";
import { setRouterInstance } from "./lib/router-instance";
import { routeTree } from "./routeTree.gen";
import { DisplayModeProvider } from "./display-mode";
import { SSEProvider } from "./realtime";
import { registerServiceWorker } from "./pwa/registerSW";
import { applyTheme, getStoredTheme } from "./lib/theme";
import { applyDocumentLocale, getLocale } from "./i18n";
import "./styles/index.css";

// index.html's boot script already pinned [data-theme] before first paint;
// this re-applies it through the same code path the toggle uses, so the
// <meta name="theme-color"> tag is in sync from the very first render even
// on a fresh profile (useTheme only mounts with the theme switcher, which
// lives behind the header menu's sheet).
applyTheme(getStoredTheme());

// index.html's boot script already pinned <html lang> before first paint;
// reading getLocale() here resolves the store (stored preference → browser
// languages → en) through the same code path the language switch uses, so
// the attribute and the dictionary can never disagree.
applyDocumentLocale(getLocale());

const router = createRouter({
  routeTree,
  basepath: getBasePath() || undefined,
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

setRouterInstance(router);
registerServiceWorker();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing from index.html");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DisplayModeProvider>
        <SSEProvider>
          <RouterProvider router={router} />
        </SSEProvider>
      </DisplayModeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
