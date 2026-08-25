// window.__BASE_PATH__ is injected into index.html by internal/webui at
// serve time (empty string, or a leading-slash/no-trailing-slash prefix
// like "/panel" — mirrors config.Config.BasePath). Every place the SPA
// builds an absolute app URL (API calls, router basepath, asset links
// outside Vite's own relative-URL handling) must go through this, or it
// breaks under a reverse-proxy sub-path deployment.
declare global {
  interface Window {
    __BASE_PATH__?: string;
  }
}

export function getBasePath(): string {
  return window.__BASE_PATH__ ?? "";
}

// withBasePath prefixes an absolute path ("/api/health") with the
// configured base path. Leaves relative paths and full URLs untouched.
export function withBasePath(path: string): string {
  if (!path.startsWith("/")) return path;
  return getBasePath() + path;
}
