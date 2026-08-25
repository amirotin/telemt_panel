import { client } from "./generated/client.gen";
import { getBasePath } from "../base-path";

// Wires the hey-api generated client to this deployment: same-origin
// requests carry the session cookie (`credentials: "include"` — the panel
// authenticates via an HttpOnly cookie, see 05-auth.md), and every request
// is prefixed with the base_path injected by internal/webui so this works
// unmodified whether the panel is served at "/" or under a reverse-proxy
// sub-path like "/panel".
client.setConfig({
  // "" is valid (root deployment) — the generated client concatenates
  // baseUrl + path directly (see generated/client/utils.gen.ts), so an
  // empty prefix and no trailing slash is exactly right, matching
  // config.Config.BasePath's own normalization.
  baseUrl: getBasePath(),
  credentials: "include",
});

export { client };
