# Telemt Panel — next

Ветка `next` — панель нового поколения (будущие релизы **1.x**), переписываемая с чистого листа: типизированный SDK Telemt API, SSE вместо WebSocket, поддержка init-систем помимо systemd (OpenRC, procd/OpenWrt, sysvinit), страница подписки для пользователей и mobile-first интерфейс.

Стабильная версия (релизы 0.x) живёт в ветке [`main`](https://github.com/amirotin/telemt_panel/tree/main).

Готово (M1+M2): типизированный SDK Telemt, store с зеркалом, аутентификация/сессии, hub+SSE, страница подписки, users API, host-матрица (systemd/openrc/procd/sysvinit/docker/none), стриминг логов, единый слой привилегий (direct/sudo/manual), движок обновлений (Telemt + самообновление).

Готово (M3): фронтенд на двух языках (русский/английский, выбор в настройках) — React SPA (`web/`, встраивается в бинарь через `internal/webui`), полный каталог экранов из 06-ui.md (Люди, Пульс с настраиваемым виджетным дашбордом, Журнал, Сервер), три режима отображения (critical/basic/extended), PWA-оболочка (manifest, service worker, иконки), Playwright e2e (`web/e2e/`) поверх собранного бинаря + `cmd/telemt-mock`, CI прогоняет фронтенд-гейты и e2e перед Go-гейтами.

Осталось до релиза 1.0: `install.sh` и миграция с 0.x (спека `v2/specs/08-migration.md`). Отдельной волной после 1.0 — M4 (auth-extras: TOTP, passkeys/WebAuthn, `/api/geoip`; см. `v2/plans/2026-08-25-m3-frontend.md`'s Ruling R1) и деплой-таймовые пункты из `v2/plans/m3-backlog.md` §CARRY (watchdog самообновления и доступ к системному журналу — Ruling R2).

Статус: ранняя разработка, ничего из этой ветки пока не предназначено для использования.

## Установка

Установщик `install.sh` — один POSIX-sh файл, работает в dash, bash и busybox (OpenWrt, Alpine). Он двуязычный (русский/английский), задаёт вопросы с пояснениями и показывает сводку перед тем, как что-то изменить.

```sh
curl -fsSL https://raw.githubusercontent.com/amirotin/telemt_panel/next/install.sh -o install.sh
sh install.sh
```

Что делает скрипт:

1. Определяет архитектуру, libc и систему запуска (systemd, OpenRC, procd/OpenWrt, sysvinit), находит Telemt: бинарь, сервис, адрес API и `auth_header` из `/etc/telemt/telemt.toml`.
2. Спрашивает адрес API Telemt и заголовок авторизации, сразу проверяет связь; адрес панели; логин и пароль администратора (можно сгенерировать); включать ли страницу подписки; путь к бинарю и имя сервиса Telemt; от кого запускать панель.
3. Показывает сводку, затем: создаёт системного пользователя `telemt-panel`, скачивает релиз с GitHub и проверяет контрольную сумму, пишет конфиг (0600), узкую политику sudo (только точные команды обновления и рестарта), файл сервиса для вашей init-системы, запускает панель и проверяет `/api/health`.
4. В конце печатает адрес панели, команды статуса/рестарта/журнала и где что лежит.

Telemt скрипт не ставит: без него панель запустится, но покажет, что чинить. После установки Telemt перезапустите скрипт — он обновит права.

| | VPS (systemd/OpenRC/sysvinit) | Роутер (procd/OpenWrt) |
|---|---|---|
| бинарь | `/usr/local/bin/telemt-panel` | `/usr/bin/telemt-panel` |
| конфиг | `/etc/telemt-panel/config.toml` | то же |
| данные | `/var/lib/telemt-panel` | `/tmp/telemt-panel` (RAM, бережём флеш) |
| сервис | `telemt-panel.service` / `/etc/init.d/telemt-panel` | `/etc/init.d/telemt-panel` |
| sudo | `/etc/sudoers.d/telemt-panel` | нет: панель работает от root |

Повторный запуск `sh install.sh` на хосте с панелью 1.x обновляет бинарь, sudoers и сервис, не трогая конфиг. На хосте с панелью 0.x скрипт предлагает миграцию: старый `config.toml` сохраняется рядом (`config.toml.0x-<дата>`), значения переносятся в формат 1.x, ключи без аналога перечисляются с пояснением.

Без вопросов (автоматизация): обязательна `TP_ADMIN_PASSWORD`, остальное берётся из детекта или переменных `TP_*` (полный список в `sh install.sh help`):

```sh
TP_ADMIN_PASSWORD='…' TP_TELEMT_URL=http://127.0.0.1:9091 TP_TELEMT_AUTH_HEADER='…' \
  sh install.sh --yes --lang ru
```

Полезные параметры: `--lang ru|en`, `--version vX.Y.Z`, `--binary FILE` (локальный бинарь, офлайн), `--dry-run` (показать план без изменений), `--no-start`. Удаление: `sh install.sh uninstall` (конфиг и данные остаются) или `sh install.sh purge` (удалить всё).

OpenWrt: чтобы конфиг пережил `sysupgrade`, добавьте `/etc/telemt-panel` в `/etc/sysupgrade.conf`.

Тесты установщика: `sh scripts/install-test.sh` (функции без доступа к хосту) и `sh scripts/install-e2e.sh` (реальная установка в user namespace с overlay поверх `/etc`, `/usr`, `/var` для каждой init-системы, миграция с 0.x, uninstall/purge; без root и Docker).

### Install (English)

`install.sh` is a single POSIX-sh installer (dash, bash, busybox) with a Russian/English interface. It detects the host (systemd, OpenRC, procd/OpenWrt, sysvinit), locates Telemt, asks a few explained questions, shows a summary, then installs the release binary, writes the config, a narrow sudoers policy and a service file, starts the panel and checks `/api/health`.

```sh
curl -fsSL https://raw.githubusercontent.com/amirotin/telemt_panel/next/install.sh -o install.sh
sh install.sh --lang en
```

Re-running it updates an existing 1.x panel (config untouched) or migrates a 0.x one (old config kept as `config.toml.0x-<date>`). Non-interactive: `TP_ADMIN_PASSWORD=… sh install.sh --yes` with `TP_*` variables listed in `sh install.sh help`. `uninstall` keeps config and data, `purge` removes everything.
