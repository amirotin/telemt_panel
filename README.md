# Telemt Panel — next

Ветка `next` — панель нового поколения (будущие релизы **1.x**), переписываемая с чистого листа: типизированный SDK Telemt API, SSE вместо WebSocket, поддержка init-систем помимо systemd (OpenRC, procd/OpenWrt, sysvinit), страница подписки для пользователей и mobile-first интерфейс.

Стабильная версия (релизы 0.x) живёт в ветке [`main`](https://github.com/amirotin/telemt_panel/tree/main).

Готово (M1+M2): типизированный SDK Telemt, store с зеркалом, аутентификация/сессии, hub+SSE, страница подписки, users API, host-матрица (systemd/openrc/procd/sysvinit/docker/none), стриминг логов, привилегии (panel-agent), движок обновлений (Telemt + самообновление).

Готово (M3): фронтенд на двух языках (русский/английский, выбор в настройках) — React SPA (`web/`, встраивается в бинарь через `internal/webui`), полный каталог экранов из 06-ui.md (Люди, Пульс с настраиваемым виджетным дашбордом, Журнал, Сервер), три режима отображения (critical/basic/extended), PWA-оболочка (manifest, service worker, иконки), Playwright e2e (`web/e2e/`) поверх собранного бинаря + `cmd/telemt-mock`, CI прогоняет фронтенд-гейты и e2e перед Go-гейтами.

Осталось до релиза 1.0: `install.sh` и миграция с 0.x (спека `v2/specs/08-migration.md`). Отдельной волной после 1.0 — M4 (auth-extras: TOTP, passkeys/WebAuthn, `/api/geoip`; см. `v2/plans/2026-08-25-m3-frontend.md`'s Ruling R1) и деплой-таймовые пункты из `v2/plans/m3-backlog.md` §CARRY (agent `.bak` allowlist, watchdog, SelectRunner re-probe, log-tail через Runner — Ruling R2).

Статус: ранняя разработка, ничего из этой ветки пока не предназначено для использования.
