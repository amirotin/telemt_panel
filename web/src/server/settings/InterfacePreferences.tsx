import { THEMES, type Theme } from "../../lib/theme";
import { useTheme } from "../../lib/useTheme";
import {
  setLocalePreference,
  useLocalePreference,
  useStrings,
  type LocalePreference,
} from "../../i18n";
import { useDisplayMode, type DisplayMode } from "../../display-mode";
import { cn } from "../../lib/cn";

const THEME_SWATCHES: Record<Theme, string> = {
  system:
    "bg-[linear-gradient(135deg,#e8edf2_0_48%,#18232d_48%_100%)] before:bg-[#243442] after:bg-[#f8fafb]",
  light: "bg-[#edf1f4] before:bg-[#cfd8df] after:bg-white",
  dark: "bg-[#15202a] before:bg-[#283b4a] after:bg-[#0e151c]",
  mocha: "bg-[#2c241f] before:bg-[#5b4032] after:bg-[#1f1a17]",
  parchment: "bg-[#eadfc9] before:bg-[#c9b794] after:bg-[#f8f0df]",
};

export function InterfacePreferences() {
  const s = useStrings();
  const [theme, setTheme] = useTheme();
  const locale = useLocalePreference();
  const { mode, setMode } = useDisplayMode();
  const normalizedMode: DisplayMode = mode === "critical" ? "basic" : mode;

  const languages: Array<{ value: LocalePreference; label: string }> = [
    { value: "ru", label: s.language.ru },
    { value: "en", label: s.language.en },
    { value: "auto", label: s.server.settings.browserLanguage },
  ];
  const modes: Array<{
    value: Exclude<DisplayMode, "critical">;
    label: string;
    note: string;
  }> = [
    {
      value: "basic",
      label: s.displayMode.basic,
      note: s.server.settings.standardModeNote,
    },
    {
      value: "extended",
      label: s.displayMode.extended,
      note: s.server.settings.extendedModeNote,
    },
  ];

  return (
    <section data-testid="settings-interface" className="overflow-hidden rounded-xl bg-surface" aria-labelledby="interface-title">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5">
        <div>
          <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-text-faint">
            {s.server.settings.thisDevice}
          </span>
          <h2 id="interface-title" className="mt-1 text-[16px] font-bold text-text">
            {s.server.settings.interfaceTitle}
          </h2>
        </div>
        <span className="rounded-full bg-accent/10 px-2.5 py-1.5 text-[10px] font-bold text-accent">
          {s.server.settings.localBadge}
        </span>
      </header>

      <fieldset className="border-b border-border px-4 py-4">
        <legend className="mb-3 text-[10px] font-extrabold uppercase tracking-[0.1em] text-text-faint">
          {s.theme.toggle}
        </legend>
        <div className="-mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-none" role="radiogroup">
          {THEMES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              onClick={() => setTheme(value)}
              className={cn(
                "min-w-[56px] flex-1 snap-start rounded-lg border px-1 py-2 text-center text-[9px] font-bold transition-colors",
                theme === value
                  ? "border-accent/60 bg-accent/10 text-text"
                  : "border-transparent text-text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "relative mx-auto block h-8 w-full overflow-hidden rounded-md border border-black/10 before:absolute before:inset-y-1.5 before:left-1.5 before:w-2 before:rounded-sm after:absolute after:inset-y-1.5 after:right-1.5 after:w-[58%] after:rounded-sm",
                  THEME_SWATCHES[value],
                )}
              />
              <span className="mt-1.5 block whitespace-nowrap">{s.theme[value]}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="border-b border-border px-4 py-4">
        <legend className="mb-3 text-[10px] font-extrabold uppercase tracking-[0.1em] text-text-faint">
          {s.language.label}
        </legend>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup">
          {languages.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={locale === option.value}
              onClick={() => setLocalePreference(option.value)}
              className={cn(
                "tap-target rounded-lg border px-2 text-[11px] font-bold transition-colors",
                locale === option.value
                  ? "border-accent/50 bg-accent/15 text-text"
                  : "border-border bg-surface-2 text-text-muted hover:text-text",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="px-4 py-4">
        <legend className="mb-3 text-[10px] font-extrabold uppercase tracking-[0.1em] text-text-faint">
          {s.displayMode.label}
        </legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup">
          {modes.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={normalizedMode === option.value}
              onClick={() => setMode(option.value)}
              className={cn(
                "min-h-[64px] rounded-lg border p-3 text-left transition-colors",
                normalizedMode === option.value
                  ? "border-accent/50 bg-accent/10"
                  : "border-border bg-surface-2 hover:border-border-strong",
              )}
            >
              <strong className="block text-[12px] text-text">{option.label}</strong>
              <span className="mt-1 block text-[10px] leading-snug text-text-faint">
                {option.note}
              </span>
            </button>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
