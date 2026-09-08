import { resolve } from "node:path";
import type { Plugin } from "vite";

// Emitted chunk URLs allow a failed import to be retried without reloading forms.
export function localeAssets(): Plugin {
  const id = "virtual:locale-urls";
  let root = "";
  let production = false;
  return {
    name: "locale-assets",
    configResolved(config) {
      root = config.root;
      production = config.command === "build";
    },
    resolveId(source) { return source === id ? "\0" + id : undefined; },
    load(source) {
      if (source !== "\0" + id) return undefined;
      const entries = ["ru", "en"].map(locale => {
        if (!production) return `${locale}: ${JSON.stringify(`/src/i18n/${locale}.ts`)}`;
        const ref = this.emitFile({ type: "chunk", id: resolve(root, `src/i18n/${locale}.ts`), name: locale, preserveSignature: "strict" });
        return `${locale}: import.meta.ROLLUP_FILE_URL_${ref}`;
      });
      return `export const localeURLs = {${entries.join(",")}};`;
    },
  };
}
