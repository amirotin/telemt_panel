# Telemt Panel — next

Ветка `next` — панель нового поколения (будущие релизы **1.x**), переписываемая с чистого листа: типизированный SDK Telemt API, SSE вместо WebSocket, поддержка init-систем помимо systemd (OpenRC, procd/OpenWrt, sysvinit), страница подписки для пользователей и mobile-first интерфейс.

Стабильная версия (релизы 0.x) живёт в ветке [`main`](https://github.com/amirotin/telemt_panel/tree/main).

Готово (M1+M2): типизированный SDK Telemt, раздельные локальное состояние и хранилище истории, аутентификация/сессии, hub+SSE, страница подписки, users API, host-матрица (systemd/openrc/procd/sysvinit/docker/none), стриминг логов, единый слой привилегий (direct/sudo/manual), движок обновлений (Telemt + самообновление).

Готово (M3): фронтенд на двух языках (русский/английский, выбор в настройках) — React SPA (`web/`, встраивается в бинарь через `internal/webui`): Сводка, Люди, Пульс с подробными страницами диагностики, Журнал и Сервер. Адаптивный интерфейс для телефона, планшета и десктопа, PWA-оболочка (manifest, service worker, иконки), Playwright e2e (`web/e2e/`) поверх собранного бинаря + `cmd/telemt-mock`. CI прогоняет фронтенд-гейты и e2e перед Go-гейтами.

До релиза 1.0 продолжается функциональная доработка и стабилизация. В истории IP доступна локальная география (страна, ASN, опционально город); источники и обновления баз настраиваются в разделе «Сервер → Настройки панели → География IP».

Статус: ранняя разработка, ничего из этой ветки пока не предназначено для использования.

## Установка

Установщик `install.sh` — один POSIX-sh файл, работает в dash, bash и busybox (OpenWrt, Alpine). Он двуязычный (русский/английский), задаёт вопросы с пояснениями и показывает сводку перед тем, как что-то изменить.

```sh
curl -fsSL https://raw.githubusercontent.com/amirotin/telemt_panel/next/install.sh -o install.sh
sh install.sh
```

Что делает скрипт:

1. Определяет архитектуру, libc и систему запуска (systemd, OpenRC, procd/OpenWrt, sysvinit), находит Telemt: бинарь, сервис, адрес API и `auth_header` из `/etc/telemt/telemt.toml`.
2. Спрашивает адрес API Telemt и заголовок авторизации, сразу проверяет связь; режим доступа (встроенный ACME, готовый сертификат, reverse proxy или без HTTPS) и адрес панели; логин и пароль администратора; хранилище панели; путь к бинарю и имя сервиса Telemt; от кого запускать панель.
3. Показывает сводку, затем: создаёт системного пользователя `telemt-panel`, скачивает релиз с GitHub и проверяет контрольную сумму, пишет конфиг (0600), узкую политику sudo (только точные команды обновления и рестарта), файл сервиса для вашей init-системы, запускает панель и проверяет `/api/health`.
4. В конце печатает адрес панели, команды статуса/рестарта/журнала и где что лежит.

Telemt скрипт не ставит: без него панель запустится, но покажет, что чинить. После установки Telemt перезапустите скрипт — он обновит права.

| | VPS (systemd/OpenRC/sysvinit) | Роутер (procd/OpenWrt) |
|---|---|---|
| вариант | full: memory, SQLite | lite: memory |
| бинарь | `/usr/local/bin/telemt-panel` | `/usr/bin/telemt-panel` |
| конфиг | `/etc/telemt-panel/config.toml` | то же |
| данные | `/var/lib/telemt-panel` | `/tmp/telemt-panel` (RAM, бережём флеш) |
| хранилище | `panel-state.json` + история в SQLite | `panel-state.json` во временном каталоге + история в RAM |
| сервис | `telemt-panel.service` / `/etc/init.d/telemt-panel` | `/etc/init.d/telemt-panel` |
| sudo | `/etc/sudoers.d/telemt-panel` | нет: панель работает от root |

Повторный запуск `sh install.sh` на хосте с панелью 1.x обновляет бинарь, sudoers и сервис, не трогая конфиг. На хосте с панелью 0.x скрипт предлагает миграцию: старый `config.toml` сохраняется рядом (`config.toml.0x-<дата>`), значения переносятся в формат 1.x, ключи без аналога перечисляются с пояснением.

Без вопросов (автоматизация): обязательна `TP_ADMIN_PASSWORD`, остальное берётся из детекта или переменных `TP_*` (полный список в `sh install.sh help`):

```sh
TP_ADMIN_PASSWORD='…' TP_TELEMT_URL=http://127.0.0.1:9091 TP_TELEMT_AUTH_HEADER='…' \
  sh install.sh --yes --lang ru
```

Полезные параметры: `--lang ru|en`, `--version vX.Y.Z`, `--variant full|lite`, `--binary FILE` (локальный бинарь, офлайн), `--dry-run` (показать план без изменений), `--no-start`. Удаление: `sh install.sh uninstall` (конфиг и данные остаются) или `sh install.sh purge` (удалить всё).

| Доступ | Автоматизация |
| --- | --- |
| Встроенный ACME | `TP_TLS_MODE=acme TP_TLS_DOMAIN=panel.example.com`; по умолчанию HTTPS на 8443, HTTP-01 на публичном 80 |
| Готовый сертификат | `TP_TLS_MODE=certificate TP_TLS_CERT_FILE=… TP_TLS_KEY_FILE=…` |
| За reverse proxy | `TP_TLS_MODE=proxy`; по умолчанию HTTP на 127.0.0.1:8080 |
| Без HTTPS | `TP_TLS_MODE=http`; HTTP на 0.0.0.0:8080 с предупреждением об отсутствии шифрования |

При `--yes` без `TP_TLS_MODE` сохраняется HTTP-режим с предупреждением.
ACME работает внутри бинарника, без acme.sh и cron. Сертификаты и ключи лежат
в постоянном каталоге, отдельно от истории; `TP_TLS_CACHE_DIR` переопределяет
каталог установщика. Нестандартный каталог нужно заранее подготовить с правами
записи для пользователя сервиса. Подробности о DNS, портах и параметрах `[tls]` —
в [конфигурации панели](docs/CONFIG.md#tls--https-самой-панели).

После установки режим можно изменить в «Сервер → Настройки → Доступ к панели».
Панель сначала проверяет listener и сертификат, затем отдельно сохраняет конфиг
и предлагает перезапуск. До перезапуска старый адрес остаётся действующим, а
новый показывается как ожидающий применения. Если безопасная запись или
управляемый перезапуск недоступны, интерфейс показывает путь к конфигу и команду
для ручного выполнения. Веб-интерфейс не изменяет firewall, reverse proxy или
`trusted_proxies` и не обещает внешнюю доступность нового порта.

Установщик может добавить только входящие TCP allow-правила в уже активный UFW
или firewalld: порт публичного listener и дополнительно 80 для ACME. Он не
устанавливает и не включает firewall, не удаляет прежние правила и не меняет
iptables/nftables напрямую. Для firewalld правила добавляются без общего reload,
в runtime и permanent-конфигурацию, только когда входящая зона определяется
однозначно; иначе установщик печатает порты для ручной настройки. Подтверждение
по умолчанию — «нет», а `--yes` не является согласием. Для автоматизации нужно
отдельно задать `TP_OPEN_FIREWALL=yes`; `TP_OPEN_FIREWALL=no` всегда запрещает
изменения. Firewall облачного провайдера, security groups и NAT всё равно нужно
настроить отдельно: успешное локальное правило не доказывает доступность панели
из интернета.

OpenWrt: чтобы конфиг пережил `sysupgrade`, добавьте `/etc/telemt-panel` в `/etc/sysupgrade.conf`.

При обновлении существующей установки скрипт сохраняет конфиг, unit/init-скрипт,
sudoers и firewall. Меняется только бинарник, с резервной копией и проверкой
запущенной версии по HTTP/HTTPS. При отказе прежний бинарник восстанавливается;
ошибка обновления остаётся ненулевым кодом выхода. Это относится и к конфигу 0.6 —
он сохраняется без автоматической перезаписи. Подробности и ограничения —
[обновление установщиком](docs/UPGRADING.md).

Тесты установщика: `sh scripts/install-test.sh` (функции без доступа к хосту) и `sh scripts/install-e2e.sh` (реальная установка в user namespace с overlay поверх `/etc`, `/usr`, `/var` для каждой init-системы, миграция с 0.x, uninstall/purge; без root и Docker).

Если забыт пароль администратора, используйте [локальное восстановление доступа](docs/ACCESS_RECOVERY.md).

Перед изменениями можно выполнить `telemt-panel config check --config config.toml`.
Команда проверяет TOML без запуска сервисов или записи файлов; `config inspect`
выдаёт сводку без секретов. Поддерживается предварительная проверка формата 0.6,
но не применение миграции. Подробнее — [проверка конфигурации](docs/CONFIG.md#проверка-без-запуска).

Отдельный подготовительный шаг `config import-state` переносит в пустое локальное
состояние политику проверки версий из 0.6 (check/off, 6 часов, без автоустановки)
и сохраняет остальные настройки для последующей обработки. Требуется остановленная
панель; это ещё не полный переход. [Условия и ограничения](docs/CONFIG.md#подготовка-состояния-из-06).

Первый обычный запуск на конфиге 0.6 выполняет этот перенос автоматически, не меняя
исходный файл. Сессии 1.x сохраняются между рестартами, локальные GeoIP-базы
активируются после проверки. [Режим совместимости и ограничения](docs/CONFIG.md#запуск-со-старым-конфигом-06).

## Хранилище панели

Для обычного сервера установщик включает SQLite:

```toml
[store]
driver = "sqlite"
path = "/var/lib/telemt-panel/panel.db"
```

Обязательное состояние панели хранится отдельно в `data_dir/panel-state.json`: сессии, настройки входа, nonce, политики, passkeys, ограниченный аудит и recovery-журнал обновлений. SQLite содержит только историю наблюдаемости. На странице **Сервер → Настройки панели → История и хранение** у каждой категории своя карточка с переключателем и сроком хранения: технические метрики, события, проблемы подключений, общий трафик, расширенная диагностика, аудит и пользовательская история. Живые графики продолжают работать без записи на диск. Сбор IP остаётся постоянным, его срок настраивается отдельно. Для трафика пользователей панель всегда ведёт накопительный итог и baseline, а переключатель категории управляет только временными корзинами для графиков. Уменьшение срока, очистка графиков и полный сброс учёта требуют подтверждения.

На procd/OpenWrt установщик оставляет `driver = "memory"`: история ограничена RAM-кольцом и пропадает после перезапуска, чтобы не создавать постоянную запись на флеш. Обязательное состояние при заданном `data_dir` продолжает сохраняться в `panel-state.json`; смена драйвера истории его не перемещает и не преобразует.

Для резервной копии и переноса предусмотрены `telemt-panel store export/import`. Импорт для любого драйвера и экспорт из `memory` требуют заданный `data_dir`; SQLite может экспортировать постоянную history-часть и без него. SQLite переносит состояние и history-часть в пустую базу. Для `memory` команды работают только с постоянным состоянием панели: импорт backup с метриками, событиями, трафиком или IP-историей отклоняется, поскольку эта история пропала бы после перезапуска. Текущий переносимый формат имеет `format_version: 7`, и импорт принимает только версию 7. SQLite history-store открывает только пустую базу с `user_version: 0` или готовую схему `user_version: 11`; промежуточные схемы разработки 1–10 и более новые версии отклоняются без преобразования данных. Параметры файла конфигурации описаны в [`docs/CONFIG.md`](docs/CONFIG.md).

История адресов пользователей хранится отдельно от трафика: IPv4/IPv6, первое и последнее наблюдение, без журналирования пакетов. API доступен по `/api/users/{username}/ip-history`; SQLite сохраняет до 30 дней по умолчанию, Memory — до 24 часов и только до перезапуска.

### Install (English)

The panel rejects unknown keys in its own TOML configuration and reports their
paths without values. See [configuration reference](docs/CONFIG.md). The deprecated
`telemt.config_edit_mode = "file"` remains accepted for 0.x compatibility, but
configuration editing always requires the Telemt Config API.

Source builds use the Go minor declared in the root `go.mod` (latest patch within
that minor) and Node.js 22. CI and releases use the same runtime families;
`web/go.mod` is only a package-traversal boundary, not a build-toolchain selector.
This policy does not guarantee byte-for-byte reproducible binaries.

`install.sh` is a single POSIX-sh installer (dash, bash, busybox) with a Russian/English interface. It detects the host (systemd, OpenRC, procd/OpenWrt, sysvinit), locates Telemt, asks a few explained questions, shows a summary, then installs the release binary, writes the config, a narrow sudoers policy and a service file, starts the panel and checks `/api/health`.

```sh
curl -fsSL https://raw.githubusercontent.com/amirotin/telemt_panel/next/install.sh -o install.sh
sh install.sh --lang en
```

Re-running it updates an existing 1.x panel (config untouched) or migrates a 0.x one (old config kept as `config.toml.0x-<date>`). Non-interactive: `TP_ADMIN_PASSWORD=… sh install.sh --yes` with `TP_*` variables listed in `sh install.sh help`. `uninstall` keeps config and data, `purge` removes everything.
