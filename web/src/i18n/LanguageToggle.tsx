import { Chip } from "../ui/Chip";
import { SectionLabel } from "../ui/SectionLabel";
import type { LocalePreference } from "./dict";
import { setLocalePreference, useLocalePreference, useStrings } from "./store";

// LanguageToggle — the per-device language switch in Настройки панели,
// rendered as the same segmented pill strip ThemeToggle and
// DisplayModeSwitch use so the three sit as one row of controls.
//
// "auto" is deliberately an explicit third option rather than an implicit
// default: an admin whose browser is Russian but who wants the English UI
// needs to see that "Browser" is what is currently in effect, otherwise the
// only way to discover it is to change the browser.
export function LanguageToggle() {
  const s = useStrings();
  const preference = useLocalePreference();

  const options: Array<{ value: LocalePreference; label: string }> = [
    { value: "ru", label: s.language.ru },
    { value: "en", label: s.language.en },
    { value: "auto", label: s.language.auto },
  ];

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{s.language.label}</SectionLabel>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={s.language.label}>
        {options.map((opt) => (
          <Chip
            key={opt.value}
            active={preference === opt.value}
            onClick={() => setLocalePreference(opt.value)}
          >
            {opt.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}
