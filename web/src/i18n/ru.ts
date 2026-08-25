// Single source of Russian UI strings (06-ui.md: one UI language, no
// i18n framework — just constants, so a translation stays possible later
// without a rewrite). Code/identifiers stay English; only user-facing text
// lives here. Grouped by feature area as the app grows past Task 3's shell.
export const ru = {
  app: {
    title: "Telemt Panel",
  },
  theme: {
    dark: "Тёмная",
    light: "Светлая",
    system: "Системная",
    toggle: "Тема",
  },
  health: {
    ok: "Работает",
    degraded: "Деградация",
    starting: "Запускается",
    unknown: "Нет данных",
  },
  common: {
    loading: "Загрузка…",
    retry: "Повторить",
    copy: "Копировать",
    copied: "Скопировано",
    close: "Закрыть",
    cancel: "Отмена",
    save: "Сохранить",
    error: "Ошибка",
    empty: "Пусто",
  },
} as const;
