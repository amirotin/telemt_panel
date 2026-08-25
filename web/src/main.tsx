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
import "./styles/index.css";

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
