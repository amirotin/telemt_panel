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
  displayMode: {
    label: "Детализация",
    critical: "Критично",
    basic: "Базово",
    extended: "Расширенно",
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
    copyManually: "Не удалось скопировать — выделено, скопируйте вручную",
    close: "Закрыть",
    cancel: "Отмена",
    save: "Сохранить",
    error: "Ошибка",
    empty: "Пусто",
    stale: "Данные устарели",
    yes: "да",
    no: "нет",
    off: "выкл.",
  },
  // ui — shared primitive components' own strings (Sheet reuses
  // common.close above rather than duplicating it). F7, closing fix wave:
  // these five were previously hardcoded Cyrillic literals in ui/*.tsx and
  // lib/format.ts.
  ui: {
    sparklineLabel: "Динамика значения",
    stepperDecrease: "Уменьшить",
    stepperIncrease: "Увеличить",
    byteUnits: ["Б", "КБ", "МБ", "ГБ", "ТБ"],
  },
  auth: {
    username: "Имя пользователя",
    password: "Пароль",
    signIn: "Войти",
    signingIn: "Вход…",
    signOut: "Выйти",
    // Prototype's login artboard: the brand mark carries a one-line
    // subtitle under the product name.
    tagline: "Управление MTProxy",
  },
  nav: {
    people: "Люди",
    pulse: "Пульс",
    journal: "Журнал",
    server: "Сервер",
  },
  shell: {
    menu: "Меню",
    navLabel: "Основная навигация",
    connections: "Соединения",
    // Abbreviated counter for the compact status readouts (sidebar card,
    // mobile strip) — "713 соед · 18,3 ГБ" in the prototype.
    connectionsShort: "соед",
    traffic: "Трафик",
    trafficUnavailable: "н/д",
    stale: "Устарело",
    reconnecting: "Переподключение…",
    polling: "Опрос",
    retryConnection: "Переподключить",
    placeholderDescription: "Экран появится в одной из следующих задач.",
  },
  people: {
    title: "Люди",
    searchPlaceholder: "Поиск по имени",
    // "{n}" is replaced with the total number of people — the prototype's
    // «Поиск среди 1 234», which doubles as a size cue for the list.
    searchAmongTemplate: "Поиск среди {n}",
    sortLabel: "Сортировка",
    sortField: { name: "Имя", traffic: "Трафик", connections: "Соединения" },
    // The three sort chips above the list.
    sortPreset: { activity: "Активность", name: "Имя", traffic: "Трафик" },
    // The three filter segments, with live counts rendered after a "·".
    filter: { all: "Все", online: "Онлайн", issues: "Проблемы" },
    filterLabel: "Фильтр",
    // Row/inspector meta line (people/personMeta.helpers.ts).
    meta: {
      of: "из",
      ipShort: "IP",
      idle: "Не в сети",
      quotaExhausted: "Квота исчерпана",
      expired: "Срок истёк",
      disabled: "Отключён вручную",
      notInRuntime: "Не загружен в прокси",
    },
    // Short badges at the row's right edge — kept to one word so the pill
    // stays the width of a two-digit connection count.
    badge: {
      quota: "стоп",
      expired: "срок",
      disabled: "выкл",
      notInRuntime: "н/з",
    },
    inspector: {
      title: "Инспектор",
      empty: "Выберите человека слева",
      accessLink: "Ссылка доступа",
    },
    create: "Создать",
    emptyTitle: "Пока нет пользователей",
    emptyDescription:
      "Создайте первого пользователя, чтобы выдать доступ к прокси.",
    notFoundTitle: "Пользователь не найден",
    online: "Онлайн",
    offline: "Оффлайн",
    connections: "Соединения",
    activeIps: "Активные IP",
    recentIps: "Недавние IP",
    adTag: "Ad tag",
    rateLimits: "Ограничения скорости",
    rateUp: "Отдача",
    rateDown: "Приём",
    // Bitrate units for formatBitsPerSecond (people/users.helpers.ts) —
    // decimal (1000-based) SI steps, index 0 = bit/s up to index 3 = Gbit/s.
    bitrateUnits: ["бит/с", "Кбит/с", "Мбит/с", "Гбит/с"],
    // Coarse duration-unit abbreviations for formatDurationApprox
    // (people/expiry.ts) — the detail screen's expiry countdown.
    durationUnits: {
      days: "дн.",
      hours: "ч.",
      minutes: "мин.",
    },
    status: {
      active: "Активен",
      disabled: "Отключён",
      expired: "Истёк срок",
      quota_exhausted: "Квота исчерпана",
      not_in_runtime: "Не загружен в прокси",
    },
    actions: {
      menu: "Действия",
      share: "Поделиться доступом",
      qr: "QR-код",
      openTelegram: "Открыть в Telegram",
      edit: "Изменить",
      resetQuota: "Сбросить квоту",
      disable: "Отключить",
      enable: "Включить",
      delete: "Удалить",
      cancel: "Отмена",
      confirmDelete: "Удалить пользователя?",
      confirmDeleteDescription:
        "Доступ будет отозван немедленно. Действие необратимо.",
      confirmResetQuota: "Сбросить использованную квоту трафика?",
      confirmDisable:
        "Отключить пользователя? Активные соединения будут прерваны.",
      confirmEnable: "Включить пользователя?",
      confirmRotateSecret:
        "Перевыпустить секрет? Старая ссылка подключения перестанет работать.",
      noTelegramLink: "У пользователя нет ссылки для подключения.",
      unsafeTelegramLink:
        "Ссылка подключения имеет неожиданный формат — переход отменён.",
      rotateSecret: "Сменить секрет",
    },
    share: {
      title: "Поделиться доступом",
      unavailableModule: "Страница подписки отключена в настройках панели.",
      unavailableNoLink:
        "У пользователя нет classic- или secure-ссылки, чтобы построить подписку.",
      regenerate: "Перевыпустить ссылку",
      // Short form for the inspector's three-button row, where the full
      // label would wrap onto two lines.
      regenerateShort: "Перевыпуск",
      confirmRegenerate:
        "Перевыпустить ссылку? Старая ссылка перестанет работать.",
      linkLabel: "Ссылка подписки",
    },
    form: {
      createTitle: "Новый пользователь",
      editTitle: "Изменить пользователя",
      username: "Имя пользователя",
      usernameHint: "Латиница, цифры, . _ - — до 64 символов",
      usernameInvalid: "Недопустимое имя пользователя",
      usernameTaken: "Занято другим пользователем",
      secret: "Секрет",
      secretInvalid: "Секрет должен состоять из 32 шестнадцатеричных символов",
      secretRegenerate: "Сгенерировать заново",
      show: "Показать",
      hide: "Скрыть",
      quota: "Квота трафика",
      quotaUnlimited: "Без лимита",
      quotaUnits: { MB: "МБ", GB: "ГБ" },
      expiry: "Срок действия",
      expiryPreset7d: "7 дней",
      expiryPreset30d: "30 дней",
      expiryPresetNone: "Бессрочно",
      maxConnections: "Макс. соединений",
      maxIps: "Макс. уникальных IP",
      rateUpLabel: "Скорость отдачи, бит/с",
      rateDownLabel: "Скорость приёма, бит/с",
      advanced: "Дополнительно",
      fieldModeKeep: "Не менять",
      fieldModeClear: "Снять",
      fieldModeSet: "Установить",
      submitCreate: "Создать",
      submitEdit: "Сохранить",
      submitting: "Сохранение…",
    },
    toast: {
      created: "Пользователь создан",
      updated: "Пользователь обновлён",
      deleted: "Пользователь удалён",
      quotaReset: "Квота сброшена",
      enabled: "Пользователь включён",
      disabled: "Пользователь отключён",
      secretRotated: "Секрет обновлён",
      sublinkRegenerated: "Ссылка перевыпущена",
    },
    newSecret: {
      title: "Новый секрет",
      warning: "Секрет показывается один раз — скопируйте его сейчас.",
      close: "Готово",
    },
    detail: {
      metrics: "Метрики",
      quota: "Квота",
      activeIpsTitle: "Активные IP",
      noActiveIps: "Нет активных соединений",
      recentIpsTitle: "Недавние IP",
      linksTitle: "Ссылки подключения",
      linkTypeClassic: "Обычная",
      linkTypeSecure: "Secure (dd)",
      linkTypeTls: "Fake-TLS (ee)",
      server: "Сервер",
      port: "Порт",
      secret: "Секрет",
      domain: "SNI-домен",
      noExpiry: "Бессрочно",
      expiresInTemplate: "Истекает через {amount}",
      expiredAgoTemplate: "Истёк {amount} назад",
    },
  },
  pulse: {
    title: "Пульс",
    configure: "Настроить",
    done: "Готово",
    reset: "Сбросить к умолчанию",
    resetConfirm: "Вернуть раскладку дашборда к умолчанию?",
    catalogTitle: "Виджеты",
    catalogHint: "Отметьте виджеты и настройте порядок стрелками.",
    moveUp: "Переместить вверх",
    moveDown: "Переместить вниз",
    show: "Показать",
    hide: "Скрыть",
    hideWidget: "Скрыть виджет",
    alwaysOn: "Всегда включён",
    unavailableInMode: "Недоступно в текущем режиме",
    diagLink: "Диагностика",
    emptyLayoutTitle: "Дашборд пуст",
    emptyLayoutDescription: "Включите виджеты в режиме «Настроить».",
    widgets: {
      health_hero: "Статус",
      stat_row: "Показатели",
      problems: "Проблемы",
      active_sessions: "Активные сессии",
      dc: "Дата-центры",
      upstreams: "Апстримы",
      me_pool: "ME pool",
      nat_stun: "NAT/STUN",
      selftest: "Self-test",
      recent_events: "Последние события",
      security_posture: "Безопасность",
      tls_fingerprints: "TLS fingerprints",
    },
    health: {
      readyLabel: "Готовность",
      ready: "Готов",
      notReady: "Не готов",
      readOnly: "Только чтение",
      noReason: "Причина не указана.",
    },
    stat: {
      connections: "Соединения",
      connectionsApprox: "Соединения (оценка)",
      activeUsers: "Активные пользователи",
      activeUsersApprox: "Активные пользователи (оценка)",
      traffic: "Трафик (15 мин)",
      peak15m: "пик за 15 мин",
      uptime: "Аптайм",
    },
    problems: {
      none: "Всё в порядке",
      noneDescription: "Проблем не обнаружено.",
      handshakeFailures: "Ошибки хендшейка",
      staleTopic: "Устарели данные:",
      notReady: "Telemt не готов",
      readOnly: "Telemt в режиме только для чтения",
      capabilityGap: "Недоступна возможность:",
      connectionsBad: "Плохие соединения (всего)",
      handshakeTimeouts: "Таймауты хендшейка",
      connectionsBadByClass: "Плохие соединения",
    },
    activeSessions: {
      current: "Текущие соединения",
      viaMe: "Через ME",
      direct: "Напрямую",
      activeUsers: "Активные пользователи",
    },
    dc: {
      dc: "DC",
      coverage: "Покрытие",
      writers: "Писатели",
      load: "Нагрузка",
      empty: "Нет данных по дата-центрам.",
    },
    upstreams: {
      route: "Маршрут",
      address: "Адрес",
      healthy: "Здоров",
      unhealthy: "Нездоров",
      empty: "Нет настроенных апстримов.",
      successRate: "Успешность подключения",
    },
    mePool: {
      writersTotal: "Писателей всего",
      writersAlive: "Живых писателей",
      writersDraining: "В дренаже",
      hardswapPending: "Ожидает hardswap",
      reconnects: "Переподключения (успех/попытки)",
    },
    natStun: {
      probeEnabled: "Проба NAT включена",
      liveServers: "Живых STUN-серверов",
      v4: "IPv4",
      v6: "IPv6",
      noReflection: "Нет данных отражения",
    },
    selftest: {
      kdf: "KDF",
      timeskew: "Расхождение времени",
      pid: "ME-процесс",
      secondsSuffix: "с",
    },
    recentEvents: {
      empty: "Событий пока нет.",
      dropped: "пропущено",
    },
    securityPosture: {
      readOnly: "Только чтение",
      whitelist: "Белый список",
      whitelistEntries: "записей",
      authHeader: "Заголовок авторизации",
      proxyProtocol: "PROXY protocol",
      logLevel: "Уровень логов",
      telemetry: "Телеметрия",
    },
    tlsFingerprints: {
      empty: "Отпечатков пока нет.",
      total: "всего",
    },
  },
  diag: {
    domains: {
      connections: "Соединения",
      dc: "Дата-центры",
      upstreams: "Апстримы",
      me: "ME",
      nat: "NAT/STUN",
      security: "Безопасность",
      counters: "Счётчики",
    },
    back: "Назад",
    searchPlaceholder: "Поиск по ключу",
    noResults: "Ничего не найдено по запросу.",
    extendedOnlyTitle: "Доступно в расширенном режиме",
    extendedOnlyDescription:
      "Полный дамп счётчиков показывается только в расширенном режиме отображения.",
    switchToExtended: "Переключить на расширенный режим",
    emptyTitle: "Нет данных",
    emptyDescription: "Данные ещё не загружены или источник недоступен.",
    notFoundTitle: "Раздел диагностики не найден",
    groups: {
      totals: "Итого",
      cache: "Кэш",
      topByConnections: "Топ по соединениям",
      topByThroughput: "Топ по трафику",
      telemetry: "Телеметрия",
      dcs: "Дата-центры",
      summary: "Сводка",
      upstreams: "Апстримы",
      zeroCounters: "Счётчики подключений",
      meWritersSummary: "Сводка по писателям",
      meWriters: "Писатели",
      generations: "Поколения",
      hardswap: "Hardswap",
      writers: "Писатели",
      refill: "Довыгрузка (refill)",
      qualityCounters: "Счётчики качества",
      routeDrops: "Отбросы маршрутизации",
      familyStates: "Состояния по семействам",
      drainGate: "Разрешение дренажа",
      dcRtt: "RTT по дата-центрам",
      kdf: "KDF",
      timeskew: "Расхождение времени",
      ip: "Определённый IP",
      pid: "ME-процесс",
      bnd: "Bind-адрес",
      selftestUpstreams: "Апстримы (self-test)",
      gates: "Гейты",
      initialization: "Инициализация",
      flags: "Флаги",
      servers: "STUN-серверы",
      reflection: "Отражение (reflection)",
      posture: "Посадка безопасности",
      whitelist: "Белый список",
      effectiveLimits: "Действующие лимиты",
      tlsByFingerprint: "По отпечатку",
      tlsByIp: "По IP",
      tlsByCidr: "По подсети",
      tlsByUser: "По пользователю",
      core: "Ядро",
      upstream: "Апстримы",
      middleProxy: "Middle proxy",
      pool: "Pool",
      desync: "Desync",
      meRuntimeTuning: "Тюнинг ME (minimal runtime)",
      networkPath: "Сетевой путь",
      upstreamQualityPolicy: "Политика подключения",
      upstreamQualityCounters: "Счётчики подключения",
      upstreamQualitySummary: "Сводка по маршрутам",
      upstreamQualityUpstream: "Качество апстрима",
    },
  },
  journal: {
    tabs: { logs: "Логи", events: "События" },
    source: { telemt: "Telemt", panel: "Панель" },
    sourceLabel: "Источник",
    level: {
      error: "Ошибка",
      warn: "Предупреждение",
      info: "Инфо",
      debug: "Отладка",
    },
    levelLabel: "Уровень",
    unknownLevel: "н/д",
    searchPlaceholder: "Поиск по логам",
    // Column captions for the desktop feed's header row (the prototype's
    // ВРЕМЯ / УРОВЕНЬ / СООБЩЕНИЕ strip above the lines).
    timeColumn: "Время",
    levelColumn: "Уровень",
    messageColumn: "Сообщение",
    unitColumn: "Юнит",
    pause: "Пауза",
    resume: "Продолжить",
    clear: "Очистить",
    // {n} — see journal/timestamp.helpers.ts-adjacent helpers for the
    // substitution; kept as a template string here per the single-strings-
    // module rule rather than a function (ru.ts stays plain data).
    // newLinesTemplate captions the centered pill above a paused feed;
    // jumpToNewTemplate is the floating button that scrolls back down.
    newLinesTemplate: "+{n} новых",
    jumpToNewTemplate: "к новым · {n}",
    showEarlier: "Показать раньше",
    showMore: "Показать ещё",
    reconnecting: "Переподключение…",
    streamClosedTitle: "Поток логов остановлен",
    retryStream: "Переподключить",
    tailFallback: {
      title: "Живые логи недоступны на этой платформе",
      description:
        "Источник логов умеет отдать только последние строки — их можно загрузить вручную и обновлять по кнопке.",
      loadButton: "Загрузить хвост",
      loadMoreButton: "Обновить",
    },
    gatedTitle: "Логи недоступны на этом хосте",
    gatedDescription:
      "Платформа не даёт панели читать журнал службы. Выполните команду ниже на сервере, чтобы посмотреть логи вручную.",
    emptyTitle: "Логи ещё не поступали",
    emptyFilterTitle: "Ничего не найдено",
    emptyFilterDescription: "Измените фильтр по уровню или поисковый запрос.",
    events: {
      emptyTitle: "Событий пока нет",
      emptyDescription: "Действия администратора появятся здесь.",
      unknownAction: "Неизвестное действие",
      enabledTrue: "включён",
      enabledFalse: "отключён",
    },
  },
  gated: {
    disabledPrefix: "Выключено: ",
    defaultReason: "функция недоступна на этом сервере.",
    howToEnable: "Как включить",
    hideWidget: "Скрыть виджет",
    // Keyed by GateHintKey (web/src/caps/gateHints.ts) — the "как включить"
    // follow-up text for a disabled Telemt capability/gate. Kept here (not
    // in caps/gateHints.ts) per the single-strings-module rule; that module
    // only owns the key type + the lookup, not the Russian text itself.
    hints: {
      runtime_edge:
        "Включите runtime_edge_enabled = true в конфиге Telemt и перезапустите прокси.",
      quota: "Обновите Telemt — квоты трафика появились в более новой версии.",
      config_api:
        "Обновите Telemt или включите редактирование конфигурации через его API.",
      reload_api:
        "Обновите Telemt — горячая перезагрузка конфигурации появилась в более новой версии.",
      user_enable_disable:
        "Обновите Telemt — включение и отключение пользователей появилось в более новой версии.",
      rotate_secret:
        "Обновите Telemt — смена секрета через API появилась в более новой версии.",
      log_stream:
        "Живые логи недоступны на этой платформе — используйте разовый показ последних строк.",
      minimal_runtime_enabled:
        "Включите minimal_runtime_enabled = true в конфиге Telemt и перезапустите прокси.",
    },
  },
  server: {
    title: "Сервер",
    back: "← Сервер",
    menu: {
      config: {
        title: "Конфигурация",
        description: "Быстрые настройки и raw-редактор",
      },
      updates: {
        title: "Обновления",
        description: "Версии, обновление, автообновление",
      },
      security: {
        title: "Безопасность",
        description: "Посадка API, белые списки, TLS",
      },
      platform: {
        title: "Платформа",
        description: "Хост, привилегии, ручные команды",
      },
      settings: {
        title: "Настройки панели",
        description: "Сессии, тема, раскладка дашборда",
      },
    },
    config: {
      title: "Конфигурация",
      tabs: { quick: "Быстрые настройки", raw: "Raw" },
      sections: {
        general: "Общее",
        timeouts: "Таймауты (с)",
        censorship: "Маскировка",
      },
      fields: {
        use_middle_proxy: "Middle proxy",
        ad_tag: "Ad Tag",
        middle_proxy_nat_ip: "NAT IP",
        middle_proxy_nat_probe: "Авто-определение NAT (STUN)",
        tls_domain: "TLS домен (SNI)",
        mask: "Маскировка при неудачном хендшейке",
        mask_host: "Хост маскировки",
        tls_emulation: "Эмуляция TLS-сертификата",
        client_handshake: "Хендшейк клиента",
        tg_connect: "Подключение к Telegram",
        client_ack: "Неактивность клиента",
      },
      unknownFieldsTitle: "Прочие ключи (только чтение)",
      reloadPolicy: {
        label: "Перезагрузка после сохранения",
        none: "Не перезагружать",
        instant: "Мгновенно",
        drain: "С дренажом",
        timeoutLabel: "Таймаут дренажа, с",
      },
      save: "Сохранить",
      saving: "Сохранение…",
      noChanges: "Нет изменений",
      saved: "Конфигурация обновлена",
      changedTitle: "Изменённые ключи",
      runtimeReloadNotice:
        "Требуется перезагрузка конфигурации для применения изменений.",
      processRestartNotice: "Часть изменений требует перезапуска Telemt:",
      reloadNow: "Перезагрузить сейчас",
      restartNow: "Перезапустить Telemt",
      conflictTitle: "Конфигурация изменена на сервере",
      conflictDescription:
        "Пока вы редактировали конфигурацию, она изменилась на сервере. Изменившиеся ключи:",
      conflictReload: "Перезагрузить и повторить",
      conflictOverlapWarning:
        "Эти же ключи изменили и вы — выберите, что оставить",
      conflictReapplyMine: "Применить мои изменения поверх",
      conflictDiscardMine: "Отменить мои изменения",
      rawEditorDesktopOnly:
        "Raw-редактор доступен только на компьютере — здесь только просмотр.",
      rawEditorTitle: "Raw JSON (секции конфигурации)",
      rawParseError:
        "Некорректный JSON — изменения не будут сохранены, пока ошибка не исправлена.",
      rawUnsafeInteger:
        "Число вне безопасного диапазона (потеряет точность) — редактируйте это поле иначе",
      reload: {
        title: "Статус перезагрузки",
        states: {
          accepted: "Принято",
          preparing: "Подготовка",
          activating: "Активация",
          draining: "Дренаж",
          succeeded: "Успешно",
          rolled_back: "Откат",
          failed: "Ошибка",
        },
      },
    },
    updates: {
      title: "Обновления",
      targetNames: { telemt: "Telemt", panel: "Панель" },
      currentVersion: "Текущая версия",
      latestVersion: "Доступная версия",
      upToDate: "Установлена последняя версия",
      update: "Обновить",
      confirmPrefix: "Обновить до версии",
      lockHeld: "Другое обновление уже выполняется.",
      manualOnly: "Автоматическое обновление недоступно на этом хосте.",
      phases: {
        checking: "Проверка",
        downloading: "Скачивание",
        verifying: "Проверка целостности",
        staging: "Подготовка",
        installing: "Установка",
        restarting: "Перезапуск",
        health: "Проверка здоровья",
        done: "Готово",
        rolling_back: "Откат",
        rolled_back: "Откачено",
        failed: "Ошибка",
      },
      noActiveRun: "Обновление не выполняется",
      panelRestarting: "Панель перезапускается…",
      panelRestartTimeoutTitle: "Панель не ответила новой версией",
      panelRestartTimeoutDescription:
        "Обновлённая панель не подтвердила запуск за отведённое время. Проверьте сервис вручную или откатитесь на резервную копию бинарника (файл с расширением .bak рядом с текущим).",
      panelRestartRetry: "Повторить проверку",
      journalTitle: "Журнал прошлых запусков",
      journalEmpty: "Запусков ещё не было",
      autoUpdate: {
        title: "Автообновление",
        modes: {
          off: "Выкл.",
          check: "Только уведомлять",
          apply: "Устанавливать автоматически",
        },
        intervalLabel: "Интервал проверки, ч",
        save: "Сохранить",
        saved: "Настройки автообновления сохранены",
      },
      sseStale: "Живой прогресс недоступен — статус обновляется по опросу.",
    },
    security: {
      title: "Безопасность",
      postureTitle: "Посадка API",
      whitelistTitle: "Белый список",
      whitelistEmpty: "Белый список пуст или отключён",
      whitelistEntriesTotal: "Всего записей",
      limitsTitle: "Действующие лимиты",
      tlsTitle: "TLS-отпечатки",
      editHint: "Правится в конфиге Telemt.",
      postureFields: {
        apiReadOnly: "Только чтение API",
        apiWhitelistEnabled: "Белый список включён",
        apiAuthHeaderEnabled: "Заголовок авторизации задан",
        proxyProtocolEnabled: "PROXY protocol",
        telemetryCoreEnabled: "Телеметрия ядра",
        telemetryUserEnabled: "Телеметрия пользователей",
      },
      logLevel: "Уровень логирования",
      telemetryMeLevel: "Телеметрия ME",
      tlsExtendedOnly:
        "TLS-отпечатки показываются только в расширенном режиме.",
    },
    platform: {
      title: "Платформа",
      serviceManager: "Менеджер сервисов",
      logSource: "Источник логов",
      privilegesMode: "Режим привилегий",
      osRelease: "ОС",
      capsTitle: "Возможности",
      caps: {
        restart_telemt: "Перезапуск Telemt",
        restart_panel: "Перезапуск панели",
        log_tail: "Хвост логов",
        log_stream: "Живые логи",
        self_update: "Самообновление",
      },
      manualCommandsTitle: "Ручные команды",
      restartTelemt: "Перезапустить Telemt",
      restartConfirm:
        "Перезапустить Telemt сейчас? Активные соединения будут разорваны.",
      restarted: "Telemt перезапускается",
    },
    settings: {
      title: "Настройки панели",
      sessionsTitle: "Сессии и устройства",
      currentSessionLabel: "Это устройство",
      unknownDevice: "Неизвестное устройство",
      revoke: "Завершить",
      revokeOthers: "Завершить все остальные",
      revokeConfirm: "Завершить эту сессию?",
      revokeOthersConfirm: "Завершить все остальные сессии, кроме текущей?",
      sessionRevoked: "Сессия завершена",
      sessionsRevoked: "Остальные сессии завершены",
      lastSeen: "Последняя активность",
      created: "Создана",
      displayTitle: "Отображение",
      dashboardTitle: "Дашборд",
      resetLayout: "Сбросить раскладку дашборда",
      resetLayoutConfirm:
        "Сбросить раскладку дашборда Пульса к значениям по умолчанию?",
      resetLayoutDone: "Раскладка сброшена",
      signOut: "Выйти",
    },
  },
} as const;

// errorMessages maps every {code} the panel's JSON error envelope can carry
// (api/openapi.yaml's Error schema description — grepped from every
// WriteError call site plus every Telemt *APIError code passed through
// verbatim) to a human Russian sentence. Kept as a plain Record (not `as
// const`, unlike `ru` above) since it's looked up by a dynamic string key
// coming off the wire. See ru.test.ts for the completeness check against
// openapi.yaml's documented set.
export const errorMessages: Record<string, string> = {
  // Panel-native codes.
  bad_request: "Некорректный запрос.",
  invalid_credentials: "Неверное имя пользователя или пароль.",
  rate_limited: "Слишком много попыток входа. Подождите минуту и повторите.",
  session_expired: "Сессия истекла. Войдите снова.",
  csrf_rejected:
    "Запрос отклонён проверкой безопасности — обновите страницу и повторите.",
  internal_error: "Внутренняя ошибка панели. Попробуйте ещё раз.",
  not_found: "Не найдено.",
  telemt_unreachable: "Telemt недоступен — проверьте, что прокси запущен.",
  capability_absent: "Эта версия Telemt не поддерживает данную функцию.",
  capability_unavailable: "Функция сейчас недоступна на этом сервере.",
  manual_restart_required:
    "Автоматический перезапуск недоступен — выполните команду вручную.",
  update_locked: "Обновление уже выполняется.",
  sublink_unavailable: "Страница подписки отключена.",
  log_tail_unavailable: "Просмотр последних строк логов недоступен.",
  log_stream_unavailable: "Живые логи недоступны на этой платформе.",
  log_source_error: "Не удалось подключиться к источнику логов.",
  // Reserved for milestones not yet implemented, kept so a stray response
  // from a partially-rolled-out backend still shows something sensible.
  totp_required: "Требуется код двухфакторной аутентификации.",
  telemt_auth_failed:
    "Telemt отклонил авторизацию панели — проверьте auth_header в конфиге.",
  // Telemt *APIError codes passed through verbatim.
  user_exists: "Пользователь с таким именем уже существует.",
  last_user_forbidden: "Нельзя удалить последнего пользователя.",
  read_only: "Telemt работает в режиме только для чтения.",
  revision_conflict: "Конфигурация изменена — обновите её и повторите попытку.",
  reload_in_progress: "Перезагрузка конфигурации уже выполняется.",
  reload_not_found: "Задача перезагрузки не найдена.",
  ambiguous_listeners:
    "Неоднозначная настройка сетевых слушателей — уточните конфигурацию.",
  access_not_editable: "Этот раздел конфигурации нельзя изменить через API.",
  section_not_editable: "Этот раздел конфигурации доступен только для чтения.",
  field_not_editable: "Это поле нельзя изменить через API.",
  unauthorized: "Telemt отклонил запрос авторизации.",
  forbidden: "Операция запрещена.",
  method_not_allowed: "Метод не поддерживается.",
  config_patch_not_atomic:
    "Не удалось применить изменения конфигурации атомарно.",
  payload_too_large: "Слишком большой запрос.",
  api_disabled: "API Telemt отключён.",
  maestro_unavailable: "Внутренний сервис Telemt недоступен.",
  // Not an envelope code — synthesized client-side when fetch itself throws
  // (offline, DNS failure, CORS) rather than returning any HTTP response.
  network: "Нет соединения с сервером. Проверьте подключение и повторите.",
  // Fallback for any code not in this table (a future backend code this
  // build of the frontend doesn't know about yet).
  default: "Не удалось выполнить запрос. Попробуйте ещё раз.",
};

// errorMessage looks up a human message for an envelope {code}, falling
// back to errorMessages.default for anything unrecognized.
export function errorMessage(code: string): string {
  return errorMessages[code] ?? errorMessages["default"];
}

// auditActionLabels maps every AuditEntry.action string the panel's own
// store.appendAudit call sites emit (api/openapi.yaml's AuditEntry.action
// is a free-text field, not an enum, so there's no schema to walk the way
// errorMessages' completeness test walks Error.code — see
// journal/auditActions.test.ts's own hardcoded, commented list of backend
// call sites for the completeness check). Kept as a plain Record (not `as
// const`, same reasoning as errorMessages above) since journal/
// auditActions.ts looks it up by a dynamic action string coming off the
// wire.
export const auditActionLabels: Record<string, string> = {
  login: "Вход",
  "login.failed": "Неудачный вход",
  logout: "Выход",
  "user.create": "Создан пользователь",
  "user.patch": "Изменён пользователь",
  "user.delete": "Удалён пользователь",
  "quota.reset": "Сброшена квота",
  "secret.rotate": "Обновлён секрет",
  "user.enabled": "Изменён статус пользователя",
  "sublink.rotate": "Перевыпущена ссылка подписки",
  "config.patch": "Изменена конфигурация Telemt",
  "telemt.reload": "Перезагружена конфигурация Telemt",
  "telemt.restart": "Перезапущен Telemt",
  "update.apply": "Запущено обновление",
  "update.auto_change": "Изменены настройки авто-обновления",
};
