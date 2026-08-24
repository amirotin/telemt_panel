# Telemt Panel — next

Ветка `next` — панель нового поколения (будущие релизы **1.x**), переписываемая с чистого листа: типизированный SDK Telemt API, SSE вместо WebSocket, поддержка init-систем помимо systemd (OpenRC, procd/OpenWrt, sysvinit), страница подписки для пользователей и mobile-first интерфейс.

Стабильная версия (релизы 0.x) живёт в ветке [`main`](https://github.com/amirotin/telemt_panel/tree/main).

Готово (M1+M2): типизированный SDK Telemt, store с зеркалом, аутентификация/сессии, hub+SSE, страница подписки, users API, host-матрица (systemd/openrc/procd/sysvinit/docker/none), стриминг логов, привилегии (panel-agent), движок обновлений (Telemt + самообновление). Осталось до релиза 1.0: фронтенд (M3) и install.sh/миграция.

Статус: ранняя разработка, ничего из этой ветки пока не предназначено для использования.
