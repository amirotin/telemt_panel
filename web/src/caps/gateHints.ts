// GateHintKey enumerates the panel's static "как включить" hints for a
// disabled capability/gate — Telemt's own Gated[T] wrapper (07-telemt-sdk.md)
// already carries a dynamic `reason` string for its own sub-gates (e.g.
// "minimal runtime gate disabled"), shown as-is by <Gated>; the entries here
// are the panel-authored follow-up text for the capability flags exposed by
// GET /api/telemt/info (07-telemt-sdk.md §SDK-3) and the runtime_edge gate
// that unlocks several of the payloads underneath it.
export type GateHintKey =
  | "runtime_edge"
  | "quota"
  | "config_api"
  | "reload_api"
  | "user_enable_disable"
  | "rotate_secret"
  | "log_stream";

export const gateHints: Record<GateHintKey, string> = {
  runtime_edge:
    "Включите runtime_edge_enabled = true в конфиге Telemt и перезапустите прокси.",
  quota: "Обновите Telemt — квоты трафика появились в более новой версии.",
  config_api: "Обновите Telemt или включите редактирование конфигурации через его API.",
  reload_api: "Обновите Telemt — горячая перезагрузка конфигурации появилась в более новой версии.",
  user_enable_disable:
    "Обновите Telemt — включение и отключение пользователей появилось в более новой версии.",
  rotate_secret: "Обновите Telemt — смена секрета через API появилась в более новой версии.",
  log_stream: "Живые логи недоступны на этой платформе — используйте разовый показ последних строк.",
};
