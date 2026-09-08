import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { initializeLocale, isLocaleReady, subscribeLocale, useLocale, useLocaleLoadState } from "./store";

// This small recovery message must remain available when a dictionary cannot load.
const messages = {
  ru: { loading: "Загрузка языка…", failed: "Не удалось загрузить язык. Проверьте соединение и повторите попытку.", retry: "Повторить" },
  en: { loading: "Loading language…", failed: "Could not load the language. Check your connection and try again.", retry: "Retry" },
};

export function LocaleBootstrap({ children }: { children: ReactNode }) {
  const ready = useSyncExternalStore(subscribeLocale, isLocaleReady, isLocaleReady);
  const locale = useLocale();
  const state = useLocaleLoadState();
  useEffect(() => { void initializeLocale(); }, []);

  // Once ready, changing language never unmounts the application or its forms.
  if (ready) return children;
  const text = messages[locale];
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-6 text-text">
      <div className="max-w-sm space-y-4 text-center">
        <p className="text-lg font-semibold">Telemt Panel</p>
        <p role={state.error ? "alert" : "status"} className="text-sm text-text-muted">
          {state.error ? text.failed : text.loading}
        </p>
        {state.error && <button type="button" className="tap-target rounded-lg bg-surface-2 px-5 py-2 text-sm font-semibold" onClick={() => void initializeLocale()}>{text.retry}</button>}
      </div>
    </main>
  );
}
