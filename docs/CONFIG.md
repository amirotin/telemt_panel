# Конфигурация telemt-panel

Файл задаётся флагом `-config` (по умолчанию `config.toml`). Команда `telemt-panel version` печатает версию бинарника. Парсинг и значения по умолчанию: [`internal/config/config.go`](../internal/config/config.go). После загрузки путь к файлу сохраняется в `Config.Path` и используется для записи настроек автообновления.

Готовый шаблон с комментариями: [`config.example.toml`](../config.example.toml) в корне репозитория.

Типовые пути после установки скриптом [`install.sh`](../install.sh) (см. README, раздел «Установка через install.sh»): бинарник `/usr/local/bin/telemt-panel`, конфиг `/etc/telemt-panel/config.toml`, данные `/var/lib/telemt-panel`, unit `telemt-panel.service`, sudoers `/etc/sudoers.d/telemt-panel`.

---

## Примеры конфигурации

Ниже — типовые сценарии. Объединяйте фрагменты в один `config.toml` по необходимости.

В комментариях к строкам: **обяз.** — параметр обязателен для загрузчика [`config.Load`](../internal/config/config.go) или для выбранного режима (TLS, GeoIP и т.д.); **необяз.** — ключ можно не указывать (тогда подставится значение по умолчанию из кода или опция просто выключена). Для `telemt.auth_header` пустая строка допустима: заголовок `Authorization` к telemt **не** отправляется; если telemt требует авторизацию, обычно будет 401 → 502 `telemt_auth_failed` в ответе панели.

### Минимальный рабочий файл

Достаточно обязательных полей и секции `[auth]`. Остальное подставится из кода (`listen`, пути к бинарникам, репозитории GitHub и т.д.).

```toml
# необяз.; по умолч. 0.0.0.0:8080
listen = "0.0.0.0:8080"

[telemt]
# обяз.
url = "http://127.0.0.1:9091"
# необяз. в загрузчике; задайте, если telemt ждёт Authorization (как в его конфиге)
auth_header = "Bearer s3cr3t-from-telemt-config"

[auth]
# обяз.
username = "admin"
# обяз.; см. telemt-panel hash-password
password_hash = "$2a$10$..."
# обяз.
jwt_secret = "случайная-строка-не-короче-32-символов-для-продакшена"
# необяз.; по умолч. 24h (если ключ отсутствует в [auth])
session_ttl = "24h"
```

Запуск:

```bash
telemt-panel -config /etc/telemt-panel/config.toml
```

Пароль для панели (bcrypt) и случайный `jwt_secret`:

```bash
telemt-panel hash-password
openssl rand -base64 32
```

### Локальная разработка (telemt на том же хосте)

Панель слушает только `127.0.0.1:8080` (удобно для разработки без внешнего доступа); telemt — как в вашем конфиге (часто `9091`). Заголовок авторизации должен **точно** совпадать с тем, что настроен в telemt (сырой токен или `Bearer …`).

```toml
# необяз.; по умолч. 0.0.0.0:8080
listen = "127.0.0.1:8080"
# необяз.; по умолч. /var/lib/telemt-panel
data_dir = "/tmp/telemt-panel-dev"

[telemt]
# обяз.
url = "http://127.0.0.1:9091"
# необяз. в загрузчике
auth_header = "dev-shared-secret"

[auth]
# обяз.
username = "dev"
# обяз.
password_hash = "$2a$10$..."
# обяз.
jwt_secret = "dev-jwt-secret-at-least-32-chars-long!!"
# необяз.; по умолч. 24h
session_ttl = "48h"
```

### За обратным прокси с префиксом пути (`base_path`)

Панель ожидает запросы вида `https://example.com/panel/...`. Прокси передаёт **полный** путь с префиксом; панель внутри обрезает `base_path` для API и SPA.

```toml
# необяз.; по умолч. 0.0.0.0:8080
listen = "127.0.0.1:8080"
# необяз.; пусто = панель в корне пути сайта
base_path = "/panel"

[telemt]
# обяз.
url = "http://127.0.0.1:9091"
# необяз. в загрузчике
auth_header = "Bearer ..."

[auth]
# обяз.
username = "admin"
# обяз.
password_hash = "$2a$10$..."
# обяз.
jwt_secret = "..."
# необяз.; по умолч. 24h
session_ttl = "24h"
```

**Caddy** (фрагмент):

```caddyfile
handle /panel* {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx** (фрагмент; важен завершающий слэш у `proxy_pass`, чтобы префикс сохранялся):

```nginx
location /panel/ {
    proxy_pass http://127.0.0.1:8080/panel/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Обращение в браузере: `https://example.com/panel/` (точное совпадение пути с `base_path` без завершающего слэша даёт редирект **301** на `base_path/`).

### Свои TLS-сертификаты (без ACME)

Панель сама терминирует HTTPS на `listen` (часто `:443`). Порт **80** для challenge не поднимается.

```toml
# необяз.; для HTTPS на 443 обычно задают явно
listen = "0.0.0.0:443"

[tls]
# обяз. в паре с key_file для своих сертификатов (альтернатива — acme_domain)
cert_file = "/etc/letsencrypt/live/panel.example.com/fullchain.pem"
# обяз. вместе с cert_file
key_file  = "/etc/letsencrypt/live/panel.example.com/privkey.pem"

[telemt]
# обяз.
url = "https://127.0.0.1:9091"
# необяз. в загрузчике
auth_header = "Bearer ..."

[auth]
# обяз.
username = "admin"
# обяз.
password_hash = "$2a$10$..."
# обяз.
jwt_secret = "..."
# необяз.; по умолч. 24h
session_ttl = "24h"
```

`cert_file` и `key_file` задаются **вместе**; сочетание с `acme_domain` запрещено загрузчиком конфига.

### Let’s Encrypt (ACME) на самой панели

Нужны DNS на `acme_domain`, доступность **443** (основной listener) и **80** (отдельный HTTP-сервер для HTTP-01 и редиректа на HTTPS — см. [`internal/server/server.go`](../internal/server/server.go)).

```toml
# необяз.; для ACME обычно 443
listen = "0.0.0.0:443"

[tls]
# обяз. для режима Let’s Encrypt в этом примере (не сочетать с cert_file)
acme_domain = "panel.example.com"
# необяз.; по умолч. /var/lib/telemt-panel/certs
acme_cache_dir = "/var/lib/telemt-panel/certs"

[telemt]
# обяз.
url = "http://127.0.0.1:9091"
# необяз. в загрузчике
auth_header = "Bearer ..."

[auth]
# обяз.
username = "admin"
# обяз.
password_hash = "$2a$10$..."
# обяз.
jwt_secret = "..."
# необяз.; по умолч. 24h
session_ttl = "24h"
```

### Docker: фиксированный путь к конфигу telemt и логи из контейнера

Когда telemt в контейнере, API может отдавать путь к конфигу внутри контейнера, а панель на хосте должна править файл, смонтированный с хоста. Тогда задаётся `config_path`. **Логи:** если задан непустой `container_name`, источник — **только Docker** ([`logs.DetectSource`](../internal/logs/detect.go)); иначе — **journald** по `service_name`. Оба ключа не комбинируются для одного потока логов в UI.

```toml
# необяз.; по умолч. /var/lib/telemt-panel
data_dir = "/var/lib/telemt-panel"

[telemt]
# обяз.
url = "http://127.0.0.1:9091"
# необяз. в загрузчике
auth_header = "Bearer ..."
# необяз.; задайте, если путь к конфигу на диске хоста не совпадает с ответом API
config_path = "/home/admin/telemt-data/config.toml"
# необяз.; если задан — логи из Docker; иначе journald по service_name
container_name = "telemt"
# необяз.; по умолч. telemt; для логов — только если container_name пуст
service_name = "telemt"
# необяз.; по умолч. /bin/telemt
binary_path = "/usr/local/bin/telemt"

[panel]
# необяз.; по умолч. /usr/local/bin/telemt-panel
binary_path = "/usr/local/bin/telemt-panel"
# необяз.; по умолч. telemt-panel
service_name = "telemt-panel"

[auth]
# обяз.
username = "admin"
# обяз.
password_hash = "$2a$10$..."
# обяз.
jwt_secret = "..."
# необяз.; по умолч. 24h
session_ttl = "24h"
```

Пути `binary_path` должны указывать на реальные бинарники на **той** машине, где крутится панель, если из UI используются обновление/рестарт.

### Автообновление telemt и панели

Интервал — строка длительности Go; пустое значение трактуется как `1h`; меньше **5m** принудительно поднимается до **5m** (с предупреждением в лог). `auto_apply = true` для панели перезапускает процесс и обрывает сессии.

```toml
[telemt]
# обяз.
url = "http://127.0.0.1:9091"
# необяз. в загрузчике
auth_header = "Bearer ..."

[telemt.auto_update]
# необяз.; по умолч. false
enabled = true
# необяз.; пусто → 1h; минимум в коде 5m
check_interval = "6h"
# необяз.; по умолч. false
auto_apply = false

[panel]
# необяз.; без токена лимит GitHub API 60 запросов/ч с IP
github_token = "ghp_..."
# необяз.; по умолч. 10, если в TOML <= 0
max_newer_releases = 15
# необяз.; по умолч. 10, если в TOML <= 0
max_older_releases = 5

[panel.auto_update]
# необяз.; по умолч. false
enabled = true
# необяз.; пусто → 1h; минимум 5m
check_interval = "24h"
# необяз.; по умолч. false
auto_apply = false

[auth]
# обяз.
username = "admin"
# обяз.
password_hash = "$2a$10$..."
# обяз.
jwt_secret = "..."
# необяз.; по умолч. 24h
session_ttl = "24h"
```

Токен `github_token` в `[panel]` используется **и** для проверки релизов telemt, и для релизов панели ([`internal/server/server.go`](../internal/server/server.go)).

### GeoIP (MaxMind `.mmdb`)

Если указан `db_path`, файл City должен существовать и читаться при **загрузке** конфига. Если указан `asn_db_path`, ASN-файл проверяется так же **независимо** от `db_path`. Но endpoint lookup поднимается **только при непустом `db_path`** ([`server.Run`](../internal/server/server.go)): только `asn_db_path` без City не включает GeoIP в API (будет 503), хотя загрузка конфига может пройти.

```toml
[geoip]
# необяз.; без него lookup отключён (503). Задан — проверка чтения при загрузке конфига
db_path = "/var/lib/telemt-panel/GeoLite2-City.mmdb"
# необяз.; обогащение ASN; имеет смысл вместе с db_path (иначе lookup не работает)
asn_db_path = "/var/lib/telemt-panel/GeoLite2-ASN.mmdb"
```

Без `db_path` вызовы lookup отдают 503 (`geoip_disabled`). За один запрос API допускается до **2000** IP.

### Значения по умолчанию для формы «новый пользователь»

Поля только предзаполняют UI; пользователей в telemt не создают сами по себе. `expiration` — строго **RFC3339**; неверный формат — ошибка загрузки конфига. Для `max_tcp_conns` значение **0** в этом контексте означает «поле пустое в форме», а не «ноль в конфиге telemt».

```toml
# Секция [users] целиком необяз.; только предзаполнение формы в UI
[users]
ad_tag = "promo2026"                       # необяз.
max_tcp_conns = 10                         # необяз.; 0 = пустое поле в форме (не то же, что 0 в telemt)
data_quota_bytes = 5368709120              # необяз.
max_unique_ips = 5                         # необяз.
expiration = "2027-12-31T23:59:59Z"        # необяз.; непустое — строго RFC3339, иначе ошибка загрузки
```

---

## Корневые параметры

### `listen`

- **Тип:** строка (`host:port`).
- **По умолчанию:** `0.0.0.0:8080`.
- **Код:** адрес передаётся в `http.Server.Addr` ([`internal/server/server.go`](../internal/server/server.go)); сервер слушает этот сокет для HTTP или TLS (в зависимости от секции `[tls]`).

Задаёт, на каком интерфейсе и порту принимать соединения. Для ACME (Let’s Encrypt) обычно нужен `443` или другой порт с корректной маршрутизацией; отдельно поднимается HTTP на **фиксированном `:80`** (не настраивается в TOML) для HTTP-01 и редиректа на HTTPS — на хосте порт 80 не должен быть занят другим процессом.

### `base_path`

- **Тип:** строка, опционально.
- **По умолчанию:** пусто (панель в корне сайта).
- **Код:** нормализация (ведущий `/`, без завершающего `/`) в `config.Load`; использование в [`server.go`](../internal/server/server.go) и [`spa.NewHandler`](../internal/spa/spa.go).

Если задан (например `/panel123`), входящие запросы сначала проходят через `basePathHandler`: путь обрезается до внутреннего вида, чтобы маршруты API и SPA работали как без префикса. Для SPA в `index.html` подставляются `<base href="...">` и `window.__BASE_PATH__`. Для cookie сессии путь задаётся как `base_path + "/"`, чтобы сессия не «утекала» на другие приложения на том же хосте.

Запросы вне `base_path/...` получают 404. Точное совпадение пути с `base_path` без завершающего слэша → редирект **301** на `base_path/`.

### `data_dir`

- **Тип:** строка.
- **По умолчанию:** `/var/lib/telemt-panel` (если в TOML пусто или не указано).
- **Код:** [`config.Load`](../internal/config/config.go); [`updater.New`](../internal/updater/updater.go), [`panel_updater.New`](../internal/panel_updater/updater.go).

Каталог данных панели: через `sysutil.EnsureStagingDir` создаётся staging для скачивания и проверки бинарников при обновлении **telemt** и **панели**; при ошибке используется системный temp. Для панели в `data_dir` хранится файл статуса обновления (`panel-update-status.json`), чтобы после перезапуска восстановить состояние.

**Важно:** для обновлений бинарей каталог должен быть доступен на запись пользователю процесса панели (и при необходимости настроен sudo для замены бинарника — см. сообщения в [`sysutil`](../internal/sysutil/sysutil.go)).

---

## Секция `[telemt]`

Подключение к HTTP API **telemt** и параметры, связанные с управлением telemt (обновления, рестарт, логи, конфиг).

### `url`

- **Тип:** строка, **обязательная** (в `config.Load` проверяется только непустое значение).
- **Код:** базовый URL для [`proxy.NewTelemtProxy`](../internal/proxy/proxy.go), WebSocket ([`ws`](../internal/ws/)), модуля обновлений telemt ([`updater`](../internal/updater/updater.go)).

Все запросы с префиксом `/api/telemt/` проксируются на этот URL (после префикса `/api/telemt` путь передаётся в telemt). **Рекомендация:** указывать URL **без** завершающего слэша, чтобы не получить двойные слэши при склейке путей в reverse proxy.

### `auth_header`

- **Тип:** строка, необязательная для загрузчика.
- **Код:** если строка **не пустая**, в исходящих запросах к telemt и при WebSocket выставляется заголовок `Authorization` с этим значением; если **пустая** — заголовок **не** отправляется ([`proxy.go`](../internal/proxy/proxy.go), [`ws`](../internal/ws/)).

Значение должно совпадать с тем, что ожидает telemt (например `Bearer <token>` или сырой секрет). Если telemt отвечает 401, прокси преобразует это в 502 с кодом `telemt_auth_failed`, чтобы фронтенд не путал это с истечением сессии панели.

### `binary_path`

- **Тип:** строка.
- **По умолчанию:** `/bin/telemt`.
- **Код:** подстановка в [`updater.New`](../internal/updater/updater.go) → `SetBinaryPathForDetection` — определение архитектуры/варианта скачиваемого релиза и путь для замены бинарника при обновлении.

Не влияет на HTTP-прокси; нужен для операций «обновить telemt» из UI.

### `service_name`

- **Тип:** строка.
- **По умолчанию:** `telemt`.
- **Код:** [`updater.RestartService`](../internal/updater/updater.go) при рестарте после сохранения конфига / обновления; для **логов** — имя unit’а для `journalctl`, **только если** `container_name` пуст ([`logs.CheckStatus`](../internal/logs/detect.go), [`DetectSource`](../internal/logs/detect.go)).

Имя unit’а systemd для `systemctl restart` и (при отсутствии Docker-логов) для потока логов в UI.

### `github_repo`

- **Тип:** строка `owner/repo`.
- **По умолчанию:** `telemt/telemt`.
- **Код:** передаётся в модуль GitHub-релизов при проверке и установке обновлений telemt.

### `config_path`

- **Тип:** строка, опционально.
- **Код:** если не пусто, [`getTelemtConfigPath`](../internal/server/server.go) сразу возвращает этот путь для `GET/POST` `/api/telemt/config/*`; иначе путь запрашивается у telemt через API (`GetSystemInfo` → `config_path`).

Нужен для Docker или нестандартных путей, когда панель должна править конкретный файл на диске, не полагаясь на ответ API.

### `container_name`

- **Тип:** строка, опционально.
- **Код:** [`logs.CheckStatus`](../internal/server/server.go) и [`logs.DetectSource`](../internal/logs/detect.go). Если **непустой** — логи в UI идут **только** из Docker по этому имени контейнера; journald по `service_name` для логов **не** используется. Если **пусто** — источник логов определяется как journald для `service_name`.

### `[telemt.auto_update]`

Вложенная таблица типа `AutoUpdateConfig` ([`config.go`](../internal/config/config.go)).

| Параметр          | Описание |
|-------------------|----------|
| `enabled`         | Включает фоновую проверку релизов для telemt. |
| `check_interval`  | Строка длительности Go (`1h`, `30m`, …). Пустое → 1h. Некорректное → 1h с предупреждением в лог. Минимум **5m** (меньше принудительно поднимается до 5m). |
| `auto_apply`      | Если `true` и найдено обновление, вызывается установка той же логикой, что и ручное «применить». |

Регистрация: [`auto_update.Manager`](../internal/auto_update/auto_update.go) с `CheckFn`/`ApplyFn` для telemt. Изменения через UI можно сохранять в файл конфигурации панели ключами `telemt.auto_update.*` ([`QuickUpdate`](../internal/telemt_config/config.go) для `s.cfg.Path`).

---

## Секция `[panel]`

Параметры **самой панели**: путь к бинарнику, systemd, GitHub для релизов панели, лимиты списка релизов, токен API GitHub.

### `binary_path`

- **По умолчанию:** `/usr/local/bin/telemt-panel`.
- **Код:** [`panel_updater.New`](../internal/panel_updater/updater.go) — детекция варианта релиза и замена бинарника при обновлении панели.

### `service_name`

- **По умолчанию:** `telemt-panel`.
- **Код:** рестарт сервиса после обновления панели.

### `github_repo`

- **По умолчанию:** `amirotin/telemt_panel`.
- **Код:** источник релизов для UI обновления панели.

### `github_token`

- **Тип:** строка, опционально.
- **Код:** передаётся в HTTP-клиент GitHub API как `Authorization: Bearer` ([`github.FetchReleases`](../internal/github/releases.go) и связанные вызовы) для **обоих** потоков обновлений: и telemt, и panel используют один токен из `[panel]` (см. передачу `s.cfg.Panel.GithubToken` в `updater.New` и `panel_updater.New` в [`server.go`](../internal/server/server.go)).

Без токена действует лимит GitHub 60 запросов/час с IP; с токеном — до 5000/час для авторизованных запросов.

### `[panel.auto_update]`

Аналогично telemt: `enabled`, `check_interval` (те же правила 5m и парсинг), `auto_apply`. Для панели автоматическая установка перезапускает процесс и обрывает сессии — в примере конфига это отмечено комментарием.

### `max_newer_releases` / `max_older_releases`

- **Тип:** целые числа.
- **По умолчанию:** в коде загрузчика, если `<= 0`, подставляется **10** ([`updater.New`](../internal/updater/updater.go), [`panel_updater.New`](../internal/panel_updater/updater.go), константы в [`github`](../internal/github/releases.go)).

Ограничивают, сколько релизов **новее** и **старее** текущей версии попадает в выборщик версий (после фильтрации по подходящим артефактам и сортировки).

---

## Секция `[tls]`

### `cert_file` / `key_file`

- **Код:** взаимная проверка в `config.Load`: оба должны быть заданы или оба пусты; затем `ListenAndServeTLS(cert_file, key_file)` ([`server.go`](../internal/server/server.go)).

Пользовательские сертификаты (не ACME).

### `acme_domain`

- **Код:** если задан, используется `golang.org/x/crypto/acme/autocert`: кэш сертификатов, whitelist хоста, `ListenAndServeTLS("", "")`. Одновременно с `cert_file` **запрещено** (ошибка при загрузке конфига).

### `acme_cache_dir`

- **По умолчанию:** `/var/lib/telemt-panel/certs`.
- **Код:** `autocert.DirCache` для хранения полученных сертификатов.

При использовании ACME дополнительно в горутине поднимается сервер на **фиксированном `:80`** (адрес не задаётся в конфиге) для HTTP-01 challenge и редиректа на HTTPS ([`server.go`](../internal/server/server.go)); нужны права на прослушивание порта 80 (часто запуск от root или capabilities).

Если ни custom TLS, ни ACME не настроены, панель работает по обычному HTTP (`ListenAndServe`).

---

## Секция `[geoip]`

### `db_path`

- **Тип:** путь к файлу `.mmdb` (GeoLite2 City и т.п.).
- **Код:** при непустом значении файл проверяется на чтение в `config.Load`; при старте, если `db_path` не пуст, вызывается [`geoip.New`](../internal/geoip/geoip.go) с необязательным ASN. Если `db_path` пуст — endpoint `POST /api/geoip/lookup` возвращает 503 `geoip_disabled` (даже при заданном только `asn_db_path`).

### `asn_db_path`

- **Тип:** опциональный путь к ASN `.mmdb`.
- **Код:** при непустом значении файл проверяется на чтение в `config.Load` **отдельно** от `db_path`. В рантайме ASN подключается только если одновременно задан и успешно открыт City-файл (`db_path`); иначе lookup недоступен.

Максимум **2000** IP за один запрос к API lookup ([`server.go`](../internal/server/server.go)).

---

## Секция `[auth]`

### `username`

- **Обязательный.** Сравнивается с полем логина при `POST /api/auth/login` ([`server.go`](../internal/server/server.go)). На один IP действует ограничение: не более **5** неудачных попыток входа за **1 минуту** — ответ **429** с кодом `rate_limited` (берётся левый IP из `X-Forwarded-For`, если заголовок есть).

### `password_hash`

- **Обязательный.** Проверка через bcrypt ([`auth.CheckPassword`](../internal/auth/auth.go)).

Если строка **не** начинается с префикса bcrypt (`$2a$`, `$2b$`, `$2y$`), при загрузке конфига она считается открытым паролем: хэш генерируется, в лог пишется **WARNING** и готовый хэш — его нужно записать в конфиг вручную (не полагаться на это в продакшене).

Генерация хэша вручную: `telemt-panel hash-password` ([`main.go`](../main.go)).

### `jwt_secret`

- **Обязательный** (пустая строка — ошибка загрузки). Используется как симметричный ключ для подписи JWT (HMAC-SHA256) в [`auth.GenerateToken`](../internal/auth/auth.go).

Минимальная длина в коде **не** проверяется; в README рекомендуется случайная строка не короче 32 символов. Смена секрета инвалидирует все выданные сессии.

### `session_ttl`

- **Тип:** строка длительности Go.
- **По умолчанию:** перед разбором TOML в [`config.Load`](../internal/config/config.go) для `Auth.SessionTTL` задано `24h`. Парсер BurntSushi **не затирает** поля, отсутствующие в `[auth]`, поэтому при отсутствии ключа `session_ttl` в файле остаётся **24h**.

**Поведение при пустой строке или ошибке парсинга:** в [`server.Run`](../internal/server/server.go) при ошибке `time.ParseDuration` (в том числе для явного `session_ttl = ""`) тихо используется **24 часа** (без записи в лог). TTL влияет на срок JWT (`exp`) и на `MaxAge` cookie `session`.

При **входе** cookie сессии: `HttpOnly`, `SameSite=Strict`, `Secure` только при TLS (`r.TLS != nil`). При **выходе** cookie очищается с теми же `HttpOnly` и `SameSite`, поле `Secure` в коде не задаётся. За обратным прокси на HTTP до панели cookie при входе может быть без `Secure` — учитывайте модель терминации TLS.

---

## Секция `[users]`

Значения по умолчанию для формы создания пользователя в UI. Структура `UsersConfig` ([`config.go`](../internal/config/config.go)); отдаются через `GET /api/users/defaults` ([`server.go`](../internal/server/server.go)) как JSON (теги `json` у полей).

| Параметр            | Назначение |
|---------------------|------------|
| `ad_tag`            | Предзаполнение рекламного тега. |
| `max_tcp_conns`     | Число TCP-соединений. **0** в этом контексте означает «не задано» — поле в форме пустое (см. комментарий в `config.example.toml`; в самом telemt 0 может значить другое). |
| `data_quota_bytes`  | Квота трафика в байтах. |
| `max_unique_ips`    | Лимит уникальных IP. |
| `expiration`        | Строка в **RFC3339** (например `2027-12-31T23:59:59Z`). Если указана непустая, при загрузке конфига формат валидируется через `time.Parse(RFC3339)`; ошибка — отказ загрузки конфигурации. Пустая строка — поле срока не задано. |

Эти поля **не** создают пользователей сами по себе — только начальные значения в интерфейсе.

---

## Сводка обязательных полей

| Поле | Обязательность |
|------|----------------|
| `telemt.url` | Да |
| `auth.username` | Да |
| `auth.password_hash` | Да |
| `auth.jwt_secret` | Да |

Остальное либо опционально, либо имеет значения по умолчанию в коде (см. выше).

Дополнительно по режиму TLS (взаимоисключающие варианты):

| Режим | Что нужно в `[tls]` |
|--------|----------------------|
| Обычный HTTP | Не задавать ни `cert_file`/`key_file`, ни `acme_domain` |
| Свои сертификаты | Оба: `cert_file` и `key_file` |
| Let’s Encrypt (ACME) | `acme_domain` (и при необходимости `acme_cache_dir`) |

---

## Замечания по безопасности конфигурационного файла

Файл содержит секреты (`auth_header`, `password_hash`, `jwt_secret`, опционально `github_token`). Права доступа должны ограничивать чтение только пользователю сервиса (например `chmod 600`).
