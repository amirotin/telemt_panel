# Telemt Panel

Web-панель управления для [Telemt](https://github.com/telemt/telemt) MTProxy. Позволяет мониторить состояние сервера, управлять пользователями, отслеживать безопасность и обновлять бинарник — всё через браузер.

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

## Systemd

```bash
sudo cp telemt-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telemt-panel
```

> **Важно:** сервис работает от root. Это необходимо для:
> - обновления бинарников в `/usr/local/bin` и `/bin`
> - редактирования конфига Telemt в `/etc/telemt/`
> - перезапуска systemd-сервисов (`telemt`, `telemt-panel`)
>
> Если вам не нужны функции обновления и редактирования конфига, можно запустить от
> отдельного пользователя — создайте его и добавьте `User=telemt-panel` в секцию `[Service]`.

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

MIT
