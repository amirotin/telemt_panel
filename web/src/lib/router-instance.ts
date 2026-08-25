import type { AnyRouter } from "@tanstack/react-router";

// Mutable box so the global 401 interceptor (registered in lib/api/client.ts,
// evaluated at module-import time before any router exists) can navigate
// once main.tsx has actually created one — avoids a circular import between
// client.ts and main.tsx/routeTree.gen.ts.
let instance: AnyRouter | null = null;

export function setRouterInstance(router: AnyRouter): void {
  instance = router;
}

export function getRouterInstance(): AnyRouter | null {
  return instance;
}
