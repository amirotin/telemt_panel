# Telemt Panel

[![CI](https://github.com/amirotin/telemt_panel/actions/workflows/ci.yml/badge.svg)](https://github.com/amirotin/telemt_panel/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/amirotin/telemt_panel?include_prereleases)](https://github.com/amirotin/telemt_panel/releases)
[![Go](https://img.shields.io/badge/Go-1.24-00ADD8?logo=go)](https://go.dev/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/amirotin/telemt_panel?style=social)](https://github.com/amirotin/telemt_panel/stargazers)

Web-панель управления для [Telemt](https://github.com/telemt/telemt) MTProxy. Позволяет мониторить состояние сервера, управлять пользователями, отслеживать безопасность и обновлять бинарник — всё через браузер.

## Содержание

- [Скриншоты](#скриншоты)
- [Возможности](#возможности)
- [Требования](#требования)
- [Быстрый старт](#быстрый-старт)
- [Сборка](#сборка)
- [Конфигурация](#конфигурация)
- [Telegram Bot](#telegram-bot)
- [Systemd](#systemd)
- [CLI](#cli)
- [Стек](#стек)
- [Лицензия](#лицензия)

## Скриншоты

| Dashboard | Users | Runtime |
|:---------:|:-----:|:-------:|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Users](docs/screenshots/users.png) | ![Runtime](docs/screenshots/runtime.png) |

## Возможности

- **Dashboard** — здоровье сервера, uptime, соединения, общий трафик, статус DC
- **Пользователи** — CRUD через API Telemt, сортировка по колонкам, подсветка активных соединений
- **Runtime** — соединения, ME pool state, ME quality, upstream quality, NAT/STUN, self-test, события
- **Безопасность** — posture (read-only, whitelist, auth header), лимиты, whitelist
- **Upstreams** — статус upstream-серверов и пулов
- **Обновления** — проверка новой версии на GitHub, обновление бинарника в один клик с откатом при ошибке (Telemt и панель)
- **TLS** — поддержка custom-сертификатов и автоматического Let's Encrypt (ACME)
- **GeoIP** — определение геолокации по IP через MaxMind GeoLite2
- **WebSocket** — реалтайм обновление данных без перезагрузки страницы
- **Base Path** — поддержка запуска за reverse proxy на подпути
- **Telegram Bot** — встроенный менеджер Python-бота: автозапуск при старте панели, кнопка «Запустить / Остановить» с индикатором статуса и PID, конфигурация токена и admin IDs через UI с сохранением в config.toml

## Требования

- Linux (x86_64 или aarch64), любой дистрибутив (Debian, Ubuntu, Alpine, CentOS и т.д.)
- Работающий Telemt-сервер с доступным API

Для сборки из исходников:
- Go 1.24+
- Node.js 20+
- Docker (опционально, для кросс-компиляции)

## Быстрый старт

### Установка скриптом

```bash
curl -fsSL https://raw.githubusercontent.com/amirotin/telemt_panel/main/install.sh | bash
```

Скрипт скачает бинарник, создаст конфиг, настроит systemd-сервис и запустит панель.

### Ручная установка

1. Скачайте бинарник из [Releases](https://github.com/amirotin/telemt_panel/releases) (или соберите сами — см. ниже).

2. Создайте конфиг:

```bash
sudo mkdir -p /etc/telemt-panel
sudo cp config.example.toml /etc/telemt-panel/config.toml
sudo chmod 600 /etc/telemt-panel/config.toml
```

3. Сгенерируйте хеш пароля и JWT-секрет:

```bash
# Хеш пароля
./telemt-panel hash-password

# JWT-секрет
openssl rand -hex 32
```

4. Отредактируйте конфиг `/etc/telemt-panel/config.toml`:

```toml
listen = "0.0.0.0:8080"

[telemt]
url = "http://127.0.0.1:2398"
auth_header = ""

[auth]
username = "admin"
password_hash = "$2a$10$..."   # вывод hash-password
jwt_secret = "ваш_секрет"     # вывод openssl rand
session_ttl = "24h"
```

5. Запустите:

```bash
./telemt-panel --config /etc/telemt-panel/config.toml
```

Панель будет доступна на `http://ваш_сервер:8080`.

### Docker

```bash
cp config.example.toml config.toml
# отредактируйте config.toml

docker compose up -d
```

## Сборка

### Простая (локальная)

```bash
make            # собрать frontend + backend
make release    # собрать бинарники для x86_64 и aarch64
```

### Через Docker (кросс-компиляция)

```bash
# Linux/macOS
./build.sh

# Windows
build.bat
```

Бинарники появятся в `./release/`:
- `telemt-panel-x86_64-linux`
- `telemt-panel-aarch64-linux`
- `SHA256SUMS`

Бинарники статические (`CGO_ENABLED=0`) — работают на любом Linux без зависимостей.

### Переопределение версии

```bash
make backend VERSION=1.2.3
# или
go build -ldflags="-s -w -X main.version=1.2.3" -o telemt-panel .
```

## Конфигурация

Полный пример конфигурации — [`config.example.toml`](config.example.toml).

| Секция | Параметр | Описание | По умолчанию |
|--------|----------|----------|-------------|
| — | `listen` | Адрес и порт | `0.0.0.0:8080` |
| — | `base_path` | Подпуть для reverse proxy (например `/panel123`) | — |
| `[telemt]` | `url` | URL API Telemt | **обязательный** |
| `[telemt]` | `auth_header` | Authorization-заголовок к Telemt API | — |
| `[telemt]` | `binary_path` | Путь к бинарнику telemt (для обновлений) | `/bin/telemt` |
| `[telemt]` | `service_name` | Имя systemd-сервиса | `telemt` |
| `[telemt]` | `github_repo` | GitHub-репозиторий для проверки обновлений | `telemt/telemt` |
| `[telemt]` | `config_path` | Путь к конфигу Telemt (для Docker / нестандартных путей) | автоматически из API |
| `[panel]` | `binary_path` | Путь к бинарнику панели (для самообновления) | `/usr/local/bin/telemt-panel` |
| `[panel]` | `service_name` | Имя systemd-сервиса панели | `telemt-panel` |
| `[panel]` | `github_repo` | GitHub-репозиторий панели | `amirotin/telemt_panel` |
| `[panel]` | `github_token` | Personal Access Token для GitHub API. Без токена лимит — 60 запросов/час на IP (shared), с токеном — 5000/час. Нужен если при проверке обновлений появляется ошибка rate limit. Достаточно fine-grained PAT без scopes: [создать токен](https://github.com/settings/personal-access-tokens/new) | — |
| `[panel]` | `max_newer_releases` | Макс. кол-во новых версий в списке обновлений | `10` |
| `[panel]` | `max_older_releases` | Макс. кол-во старых версий в списке обновлений | `10` |
| `[auth]` | `username` | Логин администратора | **обязательный** |
| `[auth]` | `password_hash` | Bcrypt-хеш пароля | **обязательный** |
| `[auth]` | `jwt_secret` | Секрет для подписи JWT | **обязательный** |
| `[auth]` | `session_ttl` | Время жизни сессии | `24h` |
| `[tls]` | `cert_file` / `key_file` | Пользовательские TLS-сертификаты | — |
| `[tls]` | `acme_domain` | Домен для Let's Encrypt | — |
| `[tls]` | `acme_cache_dir` | Директория кеша сертификатов | `/var/lib/telemt-panel/certs` |
| `[geoip]` | `db_path` | Путь к MaxMind GeoLite2 City (.mmdb) | — |
| `[geoip]` | `asn_db_path` | Путь к MaxMind GeoLite2 ASN (.mmdb) | — |
| `[telegram]` | `enabled` | Автозапуск бота при старте панели | `false` |
| `[telegram]` | `bot_token` | Токен Telegram-бота (получить у `@botfather`) | — |
| `[telegram]` | `admin_ids` | Массив Telegram User ID администраторов бота | — |
| `[telegram]` | `bot_script` | Путь к `bot.py` | `<config_dir>/bot/bot.py` |
| `[telegram]` | `python_path` | Путь к интерпретатору Python | авто (`python3`) |

## Telegram Bot

Python-бот (`bot/bot.py`) запускается и управляется панелью как дочерний процесс — никакой ручной работы после первоначальной настройки не требуется.

### Что умеет бот

- Регистрация пользователей по заявкам (администратор одобряет / отклоняет)
- Выдача персональной MTProxy-ссылки с QR-кодом
- Статистика трафика и активных IP для каждого пользователя
- Администраторское меню: статистика всех клиентов, рассылка, чёрный список, бэкап БД
- Пересылка сообщений пользователей администраторам с возможностью ответить через Reply
- Мониторинг доступности API Telemt с уведомлениями в Telegram

### Первоначальная настройка

1. Установите зависимости Python (один раз):

```bash
cd /etc/telemt-panel/bot   # или туда, куда положили bot/
pip install -r requirements.txt
```

2. Откройте раздел **Telegram Bot** в боковом меню панели:
   - **Bot Token** — вставьте токен, полученный у `@botfather`
   - **Admin User IDs** — Telegram User ID администраторов (по одному на строку); узнать ID можно через `@userinfobot` или командой `/id` в боте
   - Нажмите **Сохранить**, затем **Запустить**

Настройки сохраняются в секцию `[telegram]` файла `config.toml`. При следующем запуске панели бот стартует автоматически.

### Управление из панели

| Действие | Описание |
|----------|----------|
| **Запустить** | Запускает процесс бота, устанавливает `enabled = true` в config.toml |
| **Остановить** | Завершает процесс, устанавливает `enabled = false` |
| **Сохранить** | Обновляет токен и admin IDs; если бот запущен — перезапускает его |
| Статус-бейдж | Обновляется каждые 3 с; показывает «Запущен (PID …)», «Остановлен» или «Ошибка» |

Если бот завершается аварийно — панель автоматически перезапустит его через 15 секунд.

### Размещение bot.py

По умолчанию панель ищет `bot.py` рядом с `config.toml` в поддиректории `bot/`:

```
/etc/telemt-panel/
├── config.toml
└── bot/
    ├── bot.py
    └── requirements.txt
```

Нестандартный путь задаётся в конфиге: `telegram.bot_script = "/path/to/bot.py"`.

### Переменные окружения бота

Переменные среды позволяют переопределить значения из `config.toml`:

| Переменная | Описание |
|------------|----------|
| `PANEL_CONFIG_PATH` | Путь к `config.toml` панели (подставляется автоматически при запуске через панель) |
| `BOT_TOKEN` | Токен бота (если не задан в config.toml) |
| `ADMIN_IDS` | ID через запятую (если не заданы в config.toml) |
| `PROXY_DOMAIN` | Домен MTProxy для генерации ссылок |
| `PROXY_PORT` | Порт MTProxy (по умолчанию `4448`) |
| `API_URL` | URL Telemt API (по умолчанию из `telemt.url` в config.toml) |

Пример: [`bot/.env.example`](bot/.env.example).

## Systemd

### Установка скриптом (рекомендуется)

Скрипт автоматически создаёт системного пользователя `telemt-panel`, устанавливает
бинарник панели в `/usr/local/bin`, конфиг в `/etc/telemt-panel`, данные в
`/var/lib/telemt-panel`, настраивает узкий `sudoers`-drop-in для обновлений и
генерирует hardened systemd-юнит:

```bash
curl -fsSL https://raw.githubusercontent.com/amirotin/telemt_panel/main/install.sh | bash
```

| Компонент | Путь |
|-----------|------|
| Бинарник панели | `/usr/local/bin/telemt-panel` |
| Конфиг панели | `/etc/telemt-panel/config.toml` |
| Данные (кэш сертификатов и т.д.) | `/var/lib/telemt-panel/` |
| Systemd-юнит | `/etc/systemd/system/telemt-panel.service` |
| Sudoers drop-in | `/etc/sudoers.d/telemt-panel` |

Сгенерированный юнит включает:

```ini
[Service]
User=telemt-panel
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/telemt-panel /var/lib/telemt-panel
```

`NoNewPrivileges` не включается, потому что сервис использует `sudo` для строго
ограниченных операций обновления.

`sudoers`-drop-in позволяет пользователю `telemt-panel` выполнять только нужные
обновлению команды: замену бинарника, очистку staging-файлов и перезапуск
`telemt.service` и `telemt-panel.service`.

### Ручная установка

```bash
sudo useradd --system --shell /usr/sbin/nologin --home /nonexistent telemt-panel
sudo cp telemt-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telemt-panel
```

> **Важно:** этот unit-файл запускает панель от пользователя `telemt-panel`.
> Если вы устанавливаете вручную, создайте пользователя и настройте права,
> эквивалентные installer-managed `sudoers`-drop-in, или отредактируйте unit
> под свою модель запуска.

### Удаление

```bash
# Только сервис и бинарник (конфиг и данные сохраняются)
./install.sh uninstall

# Полное удаление (включая пользователя telemt-panel)
./install.sh purge
```

Логи:

```bash
sudo journalctl -u telemt-panel -f
```

## CLI

```bash
telemt-panel --config config.toml    # запуск сервера
telemt-panel hash-password           # сгенерировать bcrypt-хеш
telemt-panel version                 # показать версию
```

## Стек

- **Backend:** Go 1.24, стандартная библиотека + gorilla/websocket, golang-jwt, BurntSushi/toml
- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite
- **Сборка:** Multi-stage Docker, статическая линковка

## Лицензия

[MIT](LICENSE)
