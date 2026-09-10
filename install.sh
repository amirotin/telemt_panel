#!/bin/sh
# Telemt Panel 1.x installer.
#
# Interactive, bilingual (ru/en), POSIX sh. Installs the panel binary from
# GitHub Releases, writes its config, provisions a dedicated system user with a
# narrow sudoers policy (or runs as root where that is the platform norm),
# registers a service for the detected init system (systemd, OpenRC, procd,
# sysvinit) and migrates a 0.x installation in place.
#
#   sh install.sh                # interactive install
#   sh install.sh --lang en help # every option and environment variable
#
# --dry-run skips installation changes; downloads and private preflight files
# are still needed. User-facing strings live in t() for both languages.
set -eu

# ── Constants ────────────────────────────────────────────────────────────────
REPO="amirotin/telemt_panel"
BINARY_NAME="telemt-panel"
SERVICE_NAME="telemt-panel"
SYSTEM_USER="telemt-panel"
CONFIG_DIR="/etc/telemt-panel"
CONFIG_FILE="$CONFIG_DIR/config.toml"
SUDOERS_FILE="/etc/sudoers.d/telemt-panel"
TELEMT_CONFIG="/etc/telemt/telemt.toml"
LOG_FILE="/var/log/telemt-panel.log"
HEALTH_WAIT_SECONDS=15

# Resolved after init-system detection (routers keep a different layout).
BIN_DIR="/usr/local/bin"
PANEL_BIN="$BIN_DIR/$BINARY_NAME"
DATA_DIR="/var/lib/telemt-panel"
SERVICE_FILE=""

# ── Option globals ───────────────────────────────────────────────────────────
L="en"
CMD="install"
DRY_RUN=0
ASSUME_YES=0
NO_START=0
COLOR=1
BINARY_FILE=""
REQ_VERSION=""
BUILD_VARIANT=""
VARIANT_EXPLICIT=0

# ── Detection globals ────────────────────────────────────────────────────────
ARCH=""
LIBC=""
INIT=""
HAS_SUDO=0
HAS_USERADD=0
PKG="unknown"
EXISTING="none"
TELEMT_BIN_DETECTED=""
TELEMT_SVC_DETECTED=""
TELEMT_URL_DETECTED=""
TELEMT_AUTH_DETECTED=""
TELEMT_API_ENABLED=""

# ── Answer globals ───────────────────────────────────────────────────────────
TELEMT_URL=""
TELEMT_AUTH=""
LISTEN="0.0.0.0:8080"
TLS_MODE="http"
TLS_DOMAIN=""
TLS_CERT=""
TLS_KEY=""
TLS_CACHE=""
ADMIN_USER="admin"
ADMIN_PASS=""
PASS_HASH=""
SUBPAGE_ENABLED="yes"
SUBPAGE_SECRET=""
TELEMT_BIN=""
TELEMT_SVC="telemt"
RUN_AS="user"
INSTALLED_TAG=""
STORE_DRIVER=""

SUDO=""
TEMP_DIR=""
HTTP_BODY=""
UPDATE_PENDING=0
UPDATE_STAGED=""
UPDATE_RESTORE=""
UPDATE_FINGERPRINT=""
UPDATE_COPY_MODE="-p"

# ═════════════════════════════════════════════════════════════════════════════
#  i18n
# ═════════════════════════════════════════════════════════════════════════════

# t KEY [printf args…] — prints the localised string for KEY. Strings are
# printf formats, so "%s" placeholders and "\n" work; a literal percent sign
# is written as "%%".
# shellcheck disable=SC2016  # help text mentions $LANG literally
t() {
  _k="$1"
  shift
  case "${L:-en}:$_k" in
    ru:remove_parser) _f='Для безопасного удаления нужен бинарник 1.x с config inspect. Укажите --binary /путь/telemt-panel; старый или отсутствующий бинарник не будет использоваться для угадывания путей.' ;;
    en:remove_parser) _f='Safe removal requires a 1.x binary with config inspect. Supply --binary /path/telemt-panel; paths will not be guessed from an old or missing binary.' ;;
    ru:remove_unsafe) _f='Цели удаления не прошли проверку. Дальнейшее удаление остановлено; проверьте конфиг, пути и соответствие сервиса панели.' ;;
    en:remove_unsafe) _f='Removal targets failed validation. Further removal stopped; check configuration, paths and the panel service definition.' ;;
    ru:remove_failed) _f='Операция удаления не завершена. Дальнейшее удаление остановлено; исправьте ошибку и повторите.' ;;
    en:remove_failed) _f='Removal did not complete. Further deletion stopped; resolve the error before retrying.' ;;
    ru:remove_targets) _f='Будут удалены только указанные файлы и каталоги панели. Telemt и файлы вне этих каталогов сохраняются.' ;;
    en:remove_targets) _f='Only the listed panel files and directories will be removed. Telemt and files outside those directories are retained.' ;;
    ru:update_preflight_failed) _f='Проверка существующей установки или нового бинарника не пройдена; обновление не применено.' ;;
    en:update_preflight_failed) _f='Existing installation or candidate validation failed; update not applied.' ;;
    ru:update_preserve) _f='Будет заменён только бинарник. Конфиг, сервис, права и firewall сохраняются.' ;;
    en:update_preserve) _f='Only the binary will change. Config, service, permissions and firewall are preserved.' ;;
    ru:update_legacy) _f='Конфиг 0.6 останется без изменений. При первом запуске совместимые настройки переносятся один раз; проверки версий — без автоустановки, каждые 6 часов. JWT требует нового входа.' ;;
    en:update_legacy) _f='The 0.6 config stays unchanged. First startup imports compatible settings once; version checks only, every 6 hours. JWT requires a new login.' ;;
    ru:migrate_archived_settings) _f='Старые defaults формы пользователей и лимиты списка релизов не применяются: остаются пресеты 1.x и до 10 новых / 3 старых версий. Старые значения сохраняются в архиве состояния; аккаунты и квоты Telemt не меняются.' ;;
    en:migrate_archived_settings) _f='Legacy user-form defaults and release-list limits are not applied: 1.x keeps its presets and up to 10 newer / 3 older versions. Old values are archived in panel state; Telemt accounts and quotas are unchanged.' ;;
    ru:update_dry) _f='Проверка завершена. Dry-run: бинарник, конфиг и сервис не изменены.' ;;
    en:update_dry) _f='Validation complete. Dry-run: binary, config and service unchanged.' ;;
    ru:update_backup) _f='Резервный бинарник: %s/binary. Копия не удаляется автоматически.' ;;
    en:update_backup) _f='Backup binary: %s/binary. It will not be removed automatically.' ;;
    ru:update_verified) _f='Новая версия запущена; health и версия проверены по настроенному HTTP/HTTPS.' ;;
    en:update_verified) _f='New version is running; health and version verified over configured HTTP/HTTPS.' ;;
    ru:update_apply_failed) _f='Замена, перезапуск или проверка новой версии не удались.' ;;
    en:update_apply_failed) _f='Replacement, restart or new-version readiness failed.' ;;
    ru:update_restoring) _f='Обновление не завершено; восстанавливаю прежний бинарник.' ;;
    en:update_restoring) _f='Update did not complete; restoring the previous binary.' ;;
    ru:update_restored) _f='Прежний ответ панели восстановлен. Обновление отменено; backup сохранён: %s' ;;
    en:update_restored) _f='Previous panel response restored. Update failed; backup retained: %s' ;;
    ru:update_restore_failed) _f='Автоматическое восстановление не завершено. Не удаляйте backup: %s/binary; восстановите бинарник и перезапустите сервис вручную.' ;;
    en:update_restore_failed) _f='Automatic recovery failed. Keep %s/binary; restore the binary and restart the service manually.' ;;
    ru:existing_config) _f='Найден конфиг: %s; формат проверит новый бинарник.' ;;
    en:existing_config) _f='Configuration found: %s; the candidate will validate its format.' ;;
    ru:q_transport) _f='Доступ: 1) Автоматический HTTPS (ACME)  2) Готовый сертификат  3) За reverse proxy  4) Без HTTPS' ;;
    en:q_transport) _f='Access: 1) Automatic HTTPS (ACME)  2) Existing certificate  3) Behind reverse proxy  4) No HTTPS' ;;
    ru:q_tls_domain) _f='Домен панели (без https:// и порта)' ;;
    en:q_tls_domain) _f='Panel domain (without https:// or port)' ;;
    ru:q_tls_cert) _f='Путь к сертификату (fullchain PEM)' ;;
    en:q_tls_cert) _f='Certificate path (fullchain PEM)' ;;
    ru:q_tls_key) _f='Путь к приватному ключу (PEM)' ;;
    en:q_tls_key) _f='Private key path (PEM)' ;;
    ru:tls_acme_notice) _f="ACME: домен должен указывать на сервер; публичный TCP/80 нужен для проверки и продления. HTTPS может работать на 8443, не занимая 443 у Telemt. Выбор ACME означает согласие с условиями Let's Encrypt: https://letsencrypt.org/repository/" ;;
    en:tls_acme_notice) _f="ACME: DNS must point to this server; public TCP/80 is needed for validation and renewal. HTTPS can use 8443, leaving Telemt on 443. Selecting ACME accepts the Let's Encrypt terms: https://letsencrypt.org/repository/" ;;
    ru:tls_http_notice) _f='Без HTTPS: пароль, сессия и данные передаются без шифрования. Не рекомендуется для публичного доступа; passkey на обычном HTTP недоступен. Режим выбран явно, автоматического fallback с HTTPS нет.' ;;
    en:tls_http_notice) _f='No HTTPS: passwords, sessions and data are unencrypted. Not recommended for public access; passkeys are unavailable on ordinary HTTP. This is an explicit mode, never an automatic HTTPS fallback.' ;;
    ru:tls_proxy_notice) _f='HTTPS обеспечивает ваш reverse proxy. Панель по умолчанию слушает только 127.0.0.1; trusted_proxies настройте для реального адреса прокси.' ;;
    en:tls_proxy_notice) _f='Your reverse proxy provides HTTPS. The panel defaults to 127.0.0.1; configure trusted_proxies for the actual proxy address.' ;;
    ru:tls_bad_domain) _f='Нужен один DNS-домен без схемы, порта, пробелов и wildcard (ASCII или punycode).' ;;
    en:tls_bad_domain) _f='Use one DNS domain without a scheme, port, whitespace or wildcard (ASCII or punycode).' ;;
    ru:tls_bind_rights) _f='Для ACME/низкого порта нужны права bind. В этой init-системе выберите запуск root явно (TP_RUN_AS=root) либо настройте права сервиса вручную. Установка остановлена.' ;;
    en:tls_bind_rights) _f='ACME/low ports need bind permissions. For this init system explicitly choose root (TP_RUN_AS=root), or provision service permissions manually. Installation stopped.' ;;
    ru:tls_check_failed) _f='HTTPS не готов. Причина указана выше; лог сервиса: %s. На HTTP панель не переключалась, ACME-кеш не удалён.' ;;
    en:tls_check_failed) _f='HTTPS is not ready. See the error above and service log: %s. No HTTP fallback occurred; the ACME cache was retained.' ;;
    ru:tls_cert_unreadable) _f='Сертификат и ключ должны существовать и быть доступны установщику: проверьте TP_TLS_CERT_FILE и TP_TLS_KEY_FILE. Пользователю сервиса тоже потребуется доступ на чтение.' ;;
    en:tls_cert_unreadable) _f='Certificate and key must exist and be readable by the installer: check TP_TLS_CERT_FILE and TP_TLS_KEY_FILE. The service user will also need read access.' ;;
    ru:s_tls) _f='Транспорт' ;;
    en:s_tls) _f='Transport' ;;
    ru:firewall_plan) _f='Firewall: %s. Входящие TCP-порты: %s.' ;;
    en:firewall_plan) _f='Firewall: %s. Incoming TCP ports: %s.' ;;
    ru:q_firewall) _f='Добавить эти разрешающие правила?' ;;
    en:q_firewall) _f='Add these allow rules?' ;;
    ru:firewall_manual) _f='Откройте входящие TCP-порты вручную: %s. Установщик не меняет firewall провайдера, NAT и неподдерживаемые или неактивные firewall.' ;;
    en:firewall_manual) _f='Open incoming TCP ports manually: %s. The installer does not change provider firewalls, NAT, or unsupported or inactive firewalls.' ;;
    ru:firewall_loopback) _f='Firewall: loopback-адрес панели не требует входящего правила.' ;;
    en:firewall_loopback) _f='Firewall: the panel loopback address needs no incoming rule.' ;;
    ru:firewall_none_active) _f='Активный UFW или firewalld не найден; firewall не изменён.' ;;
    en:firewall_none_active) _f='No active UFW or firewalld was found; the firewall was not changed.' ;;
    ru:firewall_manager_ambiguous) _f='Одновременно активны UFW и firewalld; firewall не изменён.' ;;
    en:firewall_manager_ambiguous) _f='UFW and firewalld are both active; the firewall was not changed.' ;;
    ru:firewall_zone_ambiguous) _f='Не удалось однозначно выбрать входящую зону firewalld; firewall не изменён.' ;;
    en:firewall_zone_ambiguous) _f='The firewalld ingress zone could not be selected unambiguously; the firewall was not changed.' ;;
    ru:firewall_rule_failed) _f='Не удалось добавить правило firewall: %s.' ;;
    en:firewall_rule_failed) _f='Could not add firewall rule: %s.' ;;
    ru:firewall_partial) _f='Успешно добавлены только эти операции; откат чужих правил не выполнялся: %s.' ;;
    en:firewall_partial) _f='Only these operations succeeded; unrelated rules were not rolled back: %s.' ;;
    ru:firewall_success) _f='Правила firewall успешно добавлены: %s (%s).' ;;
    en:firewall_success) _f='Firewall rules added successfully: %s (%s).' ;;
    ru:firewall_bad_env) _f='Недопустимое TP_OPEN_FIREWALL: ожидается yes или no.' ;;
    en:firewall_bad_env) _f='Invalid TP_OPEN_FIREWALL: expected yes or no.' ;;
    # ── generic ──
    ru:yn_yes) _f='[Y/n]' ;;
    en:yn_yes) _f='[Y/n]' ;;
    ru:yn_no) _f='[y/N]' ;;
    en:yn_no) _f='[y/N]' ;;
    ru:yes) _f='да' ;;
    en:yes) _f='yes' ;;
    ru:no) _f='нет' ;;
    en:no) _f='no' ;;
    ru:aborted) _f='Отменено. Ничего не изменено.' ;;
    en:aborted) _f='Cancelled. Nothing was changed.' ;;
    ru:dry_run_banner) _f='РЕЖИМ ПРОСМОТРА: команды печатаются, ничего не меняется.' ;;
    en:dry_run_banner) _f='DRY RUN: commands are printed, nothing is changed.' ;;
    ru:no_tty) _f='Нет терминала для ввода ответов. Скачайте скрипт и запустите его файлом:\n  curl -fsSL %s -o install.sh && sh install.sh\nили запустите без вопросов: sh install.sh --yes (значения из переменных TP_*, см. --help).' ;;
    en:no_tty) _f='No terminal to read answers from. Download the script and run it as a file:\n  curl -fsSL %s -o install.sh && sh install.sh\nor run non-interactively: sh install.sh --yes (values from TP_* variables, see --help).' ;;
    ru:invalid_choice) _f='Введите одну из цифр: %s' ;;
    en:invalid_choice) _f='Enter one of: %s' ;;
    ru:missing_env) _f='Режим --yes: не задана обязательная переменная %s.' ;;
    en:missing_env) _f='--yes mode: required variable %s is not set.' ;;
    ru:unknown_option) _f='Неизвестный параметр: %s (см. --help)' ;;
    en:unknown_option) _f='Unknown option: %s (see --help)' ;;
    ru:lang_prompt) _f='Язык / Language:  1) Русский  2) English' ;;
    en:lang_prompt) _f='Язык / Language:  1) Русский  2) English' ;;

    # ── help ──
    ru:help) _f='Установщик Telemt Panel 1.x

Использование: sh install.sh [параметры] [команда]

Команды:
  install        установить, обновить или мигрировать с 0.x (по умолчанию)
  uninstall      удалить бинарь, сервис и sudoers; конфиг и данные остаются
  purge          удалить панель, её конфиг и настроенный каталог данных
  help           эта справка

Параметры:
  --lang ru|en     язык (иначе спросим; подсказка из $LANG)
  --version vX.Y.Z конкретный релиз (иначе последний стабильный)
  --binary FILE    поставить готовый бинарь вместо скачивания
  --variant full|lite вариант бинаря (по умолчанию выбирается по системе)
  --yes            без вопросов: значения из переменных TP_* или умолчания
  --no-start       установить, но не запускать сервис
  --dry-run        показать, что будет сделано, ничего не меняя
  --no-color       без цветов

Переменные для --yes (в интерактиве задают умолчания):
  TP_LANG, TP_TELEMT_URL, TP_TELEMT_AUTH_HEADER, TP_ADMIN_USER,
  TP_ADMIN_PASSWORD (обязательна), TP_LISTEN, TP_TELEMT_BINARY,
  TP_TELEMT_SERVICE, TP_SUBPAGE=yes|no, TP_RUN_AS=user|root, TP_DATA_DIR,
  TP_VARIANT=full|lite, TP_STORE_DRIVER=sqlite|memory
  TP_TLS_MODE=acme|certificate|proxy|http (при --yes по умолчанию http),
  TP_TLS_DOMAIN, TP_TLS_CERT_FILE, TP_TLS_KEY_FILE, TP_TLS_CACHE_DIR,
  TP_OPEN_FIREWALL=yes|no (отдельное явное согласие; --yes недостаточно)

Пути: бинарь %s, конфиг %s, данные %s
' ;;
    en:help) _f='Telemt Panel 1.x installer

Usage: sh install.sh [options] [command]

Commands:
  install        install, update, or migrate from 0.x (default)
  uninstall      remove binary, service and sudoers; keep config and data
  purge          remove panel, configuration and configured data directory
  help           this help

Options:
  --lang ru|en     language (otherwise asked; hint taken from $LANG)
  --version vX.Y.Z install a specific release (default: latest stable)
  --binary FILE    install a local binary instead of downloading
  --variant full|lite binary profile (selected from the platform by default)
  --yes            no questions: values from TP_* variables or defaults
  --no-start       install everything but do not start the service
  --dry-run        show what would be done without changing anything
  --no-color       disable colours

Variables for --yes (they pre-fill defaults in interactive mode):
  TP_LANG, TP_TELEMT_URL, TP_TELEMT_AUTH_HEADER, TP_ADMIN_USER,
  TP_ADMIN_PASSWORD (required), TP_LISTEN, TP_TELEMT_BINARY,
  TP_TELEMT_SERVICE, TP_SUBPAGE=yes|no, TP_RUN_AS=user|root, TP_DATA_DIR,
  TP_VARIANT=full|lite, TP_STORE_DRIVER=sqlite|memory
  TP_TLS_MODE=acme|certificate|proxy|http (--yes defaults to http),
  TP_TLS_DOMAIN, TP_TLS_CERT_FILE, TP_TLS_KEY_FILE, TP_TLS_CACHE_DIR,
  TP_OPEN_FIREWALL=yes|no (separate explicit consent; --yes is insufficient)

Paths: binary %s, config %s, data %s
' ;;

    # ── welcome ──
    ru:welcome_title) _f='Установка Telemt Panel 1.x' ;;
    en:welcome_title) _f='Telemt Panel 1.x setup' ;;
    ru:welcome_body) _f='Панель управления для MTProxy-сервера Telemt: пользователи, статистика,\nконфиг, журнал и обновления в браузере. Скрипт:\n  • определит систему и найдёт установленный Telemt;\n  • задаст несколько вопросов — у каждого есть пояснение и значение по умолчанию;\n  • покажет сводку и только потом что-то изменит.\nTelemt сам скрипт не ставит: если его нет, панель запустится, но покажет, что чинить.' ;;
    en:welcome_body) _f='Web panel for the Telemt MTProxy server: users, statistics, config, logs and\nupdates in a browser. This script will:\n  • inspect the system and locate an installed Telemt;\n  • ask a few questions — each has an explanation and a default;\n  • show a summary before changing anything.\nIt does not install Telemt itself: without it the panel starts, but shows what to fix.' ;;
    ru:continue_q) _f='Продолжить?' ;;
    en:continue_q) _f='Continue?' ;;

    # ── steps ──
    ru:step_prereq) _f='Проверка окружения' ;;
    en:step_prereq) _f='Checking prerequisites' ;;
    ru:step_detect) _f='Определение системы' ;;
    en:step_detect) _f='Inspecting the host' ;;
    ru:step_questions) _f='Настройка' ;;
    en:step_questions) _f='Configuration' ;;
    ru:step_summary) _f='Сводка' ;;
    en:step_summary) _f='Summary' ;;
    ru:step_apply) _f='Установка' ;;
    en:step_apply) _f='Installing' ;;
    ru:step_done) _f='Готово' ;;
    en:step_done) _f='Done' ;;
    ru:step_update) _f='Обновление установленной панели' ;;
    en:step_update) _f='Updating the installed panel' ;;

    # ── prerequisites ──
    ru:need_root) _f='Нужны права root: запустите от root или пользователя с sudo.' ;;
    en:need_root) _f='Root privileges are required: run as root or as a user with sudo.' ;;
    ru:sudo_check) _f='Проверяю sudo (может спросить пароль вашего пользователя)…' ;;
    en:sudo_check) _f='Checking sudo (it may ask for your user password)…' ;;
    ru:missing_cmd) _f='Не найдена команда «%s». Установите: %s' ;;
    en:missing_cmd) _f='Command "%s" not found. Install it: %s' ;;
    ru:no_sha) _f='Нужен sha256sum, sha256 или openssl для проверки скачанного файла. Установка остановлена.' ;;
    en:no_sha) _f='sha256sum, sha256 or openssl is required to verify the download. Installation stopped.' ;;
    ru:unsafe_directory) _f='Небезопасный каталог: %s. Укажите отдельный абсолютный каталог панели, не системный или домашний каталог.' ;;
    en:unsafe_directory) _f='Unsafe directory: %s. Use a dedicated absolute panel directory, not a system or home directory.' ;;
    ru:unsafe_service) _f='Недопустимое имя сервиса: %s. Разрешены буквы латиницы, цифры, _, ., @ и -, без начального дефиса.' ;;
    en:unsafe_service) _f='Invalid service name: %s. Use letters, digits, _, ., @ or -, without a leading hyphen.' ;;
    ru:unsafe_sudoers_path) _f='Недопустимый путь sudoers: %s. Нужен абсолютный путь из букв латиницы, цифр, _, ., / и -.' ;;
    en:unsafe_sudoers_path) _f='Invalid sudoers path: %s. Use an absolute path containing only letters, digits, _, ., / or -.' ;;
    ru:prereq_ok) _f='curl/wget, tar и права есть' ;;
    en:prereq_ok) _f='curl/wget, tar and privileges are available' ;;

    # ── detection ──
    ru:unsupported_arch) _f='Архитектура %s не поддерживается (нужна x86_64, aarch64, armv7, mipsle или mips).' ;;
    en:unsupported_arch) _f='Architecture %s is not supported (need x86_64, aarch64, armv7, mipsle or mips).' ;;
    ru:no_init) _f='Не удалось распознать систему инициализации (нет systemd, OpenRC, procd, sysvinit).\nПанель можно запустить вручную: %s --config %s' ;;
    en:no_init) _f='Could not recognise the init system (no systemd, OpenRC, procd or sysvinit).\nThe panel can still be started by hand: %s --config %s' ;;
    ru:d_arch) _f='Архитектура' ;;
    en:d_arch) _f='Architecture' ;;
    ru:d_variant) _f='Вариант панели' ;;
    en:d_variant) _f='Panel variant' ;;
    ru:d_init) _f='Система запуска' ;;
    en:d_init) _f='Init system' ;;
    ru:d_sudo) _f='sudo' ;;
    en:d_sudo) _f='sudo' ;;
    ru:d_existing) _f='Панель' ;;
    en:d_existing) _f='Panel' ;;
    ru:d_available) _f='есть' ;;
    en:d_available) _f='available' ;;
    ru:d_missing) _f='нет' ;;
    en:d_missing) _f='not found' ;;
    ru:d_existing_none) _f='не установлена' ;;
    en:d_existing_none) _f='not installed' ;;
    ru:d_telemt_bin) _f='Бинарь Telemt' ;;
    en:d_telemt_bin) _f='Telemt binary' ;;
    ru:d_telemt_svc) _f='Сервис Telemt' ;;
    en:d_telemt_svc) _f='Telemt service' ;;
    ru:d_telemt_cfg) _f='Конфиг Telemt' ;;
    en:d_telemt_cfg) _f='Telemt config' ;;
    ru:d_telemt_api) _f='API Telemt' ;;
    en:d_telemt_api) _f='Telemt API' ;;
    ru:d_api_disabled) _f='выключен в конфиге ([server.api] enabled = false)' ;;
    en:d_api_disabled) _f='disabled in config ([server.api] enabled = false)' ;;
    ru:d_api_unknown) _f='адрес не найден в конфиге, будет запрошен' ;;
    en:d_api_unknown) _f='address not found in config, will be asked' ;;
    ru:telemt_missing) _f='Telemt на этом хосте не найден. Панель установится и запустится, но\nработать с прокси сможет только после установки Telemt (https://github.com/telemt/telemt).\nПосле установки Telemt перезапустите этот скрипт — он обновит права и настройки.' ;;
    en:telemt_missing) _f='Telemt was not found on this host. The panel will install and start, but\nit can manage a proxy only once Telemt is installed (https://github.com/telemt/telemt).\nRe-run this script after installing Telemt — it refreshes permissions and settings.' ;;

    # ── questions ──
    ru:q_telemt_url) _f='Адрес API Telemt' ;;
    en:q_telemt_url) _f='Telemt API address' ;;
    ru:x_telemt_url) _f='Панель общается с Telemt только через его HTTP API. Адрес задаётся в\n%s, секция [server.api], ключ listen. Если там 0.0.0.0 — укажите\n127.0.0.1 с тем же портом. Обычно менять не нужно.' ;;
    en:x_telemt_url) _f='The panel talks to Telemt only through its HTTP API. The address comes from\n%s, section [server.api], key listen. If it says 0.0.0.0, use 127.0.0.1\nwith the same port. Usually the default is right.' ;;
    ru:q_auth) _f='Заголовок авторизации API' ;;
    en:q_auth) _f='API authorization header' ;;
    ru:x_auth) _f='Значение auth_header из секции [server.api] в конфиге Telemt. Панель отправляет\nего дословно в заголовке Authorization. Если в Telemt защита выключена — оставьте\nпусто. Ввод скрыт; Enter оставляет найденное значение.' ;;
    en:x_auth) _f='The auth_header value from section [server.api] of the Telemt config. The panel\nsends it verbatim as the Authorization header. Leave empty if Telemt has no\nheader protection. Input is hidden; Enter keeps the detected value.' ;;
    ru:auth_detected) _f='найдено в конфиге: %s' ;;
    en:auth_detected) _f='detected in config: %s' ;;
    ru:auth_empty) _f='пусто' ;;
    en:auth_empty) _f='empty' ;;
    ru:checking_api) _f='Проверяю связь с Telemt API…' ;;
    en:checking_api) _f='Checking the Telemt API…' ;;
    ru:api_ok) _f='Telemt отвечает (%s)' ;;
    en:api_ok) _f='Telemt responds (%s)' ;;
    ru:api_auth) _f='Telemt отвечает, но не принял заголовок авторизации (HTTP %s).\nСверьте auth_header в %s.' ;;
    en:api_auth) _f='Telemt responds but rejected the authorization header (HTTP %s).\nCompare it with auth_header in %s.' ;;
    ru:api_refused) _f='Нет соединения с %s.\nПроверьте, что Telemt запущен, а в [server.api] стоит enabled = true и нужный listen.' ;;
    en:api_refused) _f='Cannot connect to %s.\nCheck that Telemt is running and [server.api] has enabled = true and the right listen.' ;;
    ru:api_other) _f='Неожиданный ответ от Telemt: HTTP %s.' ;;
    en:api_other) _f='Unexpected response from Telemt: HTTP %s.' ;;
    ru:api_needs_curl) _f='Для безопасной проверки API с токеном нужен curl. Установите curl или продолжите без проверки; токен будет сохранён в конфиге панели.' ;;
    en:api_needs_curl) _f='Checking a token-protected API safely requires curl. Install curl or continue without checking; the token will be saved in the panel config.' ;;
    ru:api_retry_q) _f='1) Проверить снова  2) Изменить адрес и заголовок  3) Продолжить без проверки' ;;
    en:api_retry_q) _f='1) Check again  2) Change address and header  3) Continue without checking' ;;
    ru:q_listen) _f='Адрес, на котором слушает панель' ;;
    en:q_listen) _f='Panel listen address' ;;
    ru:x_listen) _f='0.0.0.0:8080 — панель доступна снаружи по IP сервера на порту 8080.\nЕсли перед панелью будет nginx/caddy или Cloudflare-туннель — укажите 127.0.0.1:8080,\nчтобы порт не торчал в интернет.' ;;
    en:x_listen) _f='0.0.0.0:8080 makes the panel reachable from outside on port 8080.\nIf nginx/caddy or a Cloudflare tunnel will sit in front of it, use 127.0.0.1:8080\nso the port is not exposed to the internet.' ;;
    ru:port_busy) _f='Порт %s уже занят другим процессом. Панель не сможет запуститься на нём.' ;;
    en:port_busy) _f='Port %s is already in use by another process. The panel will not be able to bind it.' ;;
    ru:bad_listen) _f='Нужен формат host:port, например 0.0.0.0:8080' ;;
    en:bad_listen) _f='Expected host:port, for example 0.0.0.0:8080' ;;
    ru:q_admin_user) _f='Логин администратора' ;;
    en:q_admin_user) _f='Administrator login' ;;
    ru:x_admin_user) _f='Единственная учётная запись панели. Пароль хранится только в виде bcrypt-хеша.' ;;
    en:x_admin_user) _f='The single panel account. The password is stored only as a bcrypt hash.' ;;
    ru:q_password) _f='Пароль администратора' ;;
    en:q_password) _f='Administrator password' ;;
    ru:x_password) _f='Минимум 8 символов, ввод скрыт. Введите «g», чтобы сгенерировать надёжный пароль —\nон будет показан один раз. Сохраните его: скрипт пароль не записывает.' ;;
    en:x_password) _f='At least 8 characters, hidden input. Type "g" to generate a strong password —\nit is shown once. Save it: the script does not store the password.' ;;
    ru:q_password_again) _f='Повторите пароль' ;;
    en:q_password_again) _f='Repeat the password' ;;
    ru:pass_generated) _f='Сгенерированный пароль: %s' ;;
    en:pass_generated) _f='Generated password: %s' ;;
    ru:pass_short) _f='Пароль короче 8 символов — попробуйте ещё раз.' ;;
    en:pass_short) _f='The password is shorter than 8 characters — try again.' ;;
    ru:pass_mismatch) _f='Пароли не совпадают — попробуйте ещё раз.' ;;
    en:pass_mismatch) _f='Passwords do not match — try again.' ;;
    ru:q_subpage) _f='Включить страницу подписки?' ;;
    en:q_subpage) _f='Enable the subscription page?' ;;
    ru:x_subpage) _f='Каждому пользователю прокси можно выдать личную ссылку /sub/<токен>: страница\nбез входа в панель, с настройками подключения и QR-кодом. Ссылка отзывается\nсменой секрета пользователя. Отключить можно позже одним ключом в конфиге.' ;;
    en:x_subpage) _f='Every proxy user can get a personal /sub/<token> link: a page with connection\nsettings and a QR code, no panel login needed. Rotating the user secret revokes\nthe link. It can be turned off later with one config key.' ;;
    ru:q_telemt_bin) _f='Путь к бинарю Telemt' ;;
    en:q_telemt_bin) _f='Telemt binary path' ;;
    ru:x_telemt_bin) _f='Нужен только для обновления Telemt из панели: этот файл будет заменяться\nновой версией с резервной копией рядом.' ;;
    en:x_telemt_bin) _f='Needed only for updating Telemt from the panel: this file gets replaced by the\nnew version, with a backup next to it.' ;;
    ru:q_telemt_svc) _f='Имя сервиса Telemt' ;;
    en:q_telemt_svc) _f='Telemt service name' ;;
    ru:x_telemt_svc) _f='Так панель перезапускает Telemt после обновления или смены конфига\n(%s). Обычно «telemt».' ;;
    en:x_telemt_svc) _f='This is how the panel restarts Telemt after an update or a config change\n(%s). Usually "telemt".' ;;
    ru:q_run_as) _f='От чьего имени запускать панель?' ;;
    en:q_run_as) _f='Which account should run the panel?' ;;
    ru:x_run_as) _f='1) Отдельный пользователь %s (рекомендуется). Панель не имеет прав root;\n   для замены бинарей и перезапуска сервисов ей выдаётся короткий список точных\n   команд через sudo (%s).\n2) root. Проще, но компрометация панели даёт полный доступ к серверу.' ;;
    en:x_run_as) _f='1) A dedicated user %s (recommended). The panel has no root rights; replacing\n   binaries and restarting services goes through a short list of exact sudo\n   commands (%s).\n2) root. Simpler, but a compromised panel means full access to the server.' ;;
    ru:run_as_forced_procd) _f='На OpenWrt сервисы работают от root, отдельный пользователь не создаётся.' ;;
    en:run_as_forced_procd) _f='On OpenWrt services run as root; no dedicated user is created.' ;;
    ru:run_as_forced_nosudo) _f='На хосте нет sudo или useradd — панель будет работать от root.\nЧтобы запускать её от отдельного пользователя, установите sudo и запустите скрипт снова.' ;;
    en:run_as_forced_nosudo) _f='No sudo or useradd on this host — the panel will run as root.\nInstall sudo and re-run the script to run it as a dedicated user.' ;;
    ru:q_storage) _f='Где хранить историю наблюдаемости?\n1) SQLite — файл на этом сервере (рекомендуется)\n2) Память — история пропадёт после перезапуска' ;;
    en:q_storage) _f='Where should observability history be stored?\n1) SQLite — a file on this server (recommended)\n2) Memory — history is lost on restart' ;;
    ru:x_storage) _f='SQLite подходит для постоянной истории одной панели.\nТехнические метрики сохраняются всегда; остальные категории можно отключить в интерфейсе.' ;;
    en:x_storage) _f='SQLite provides durable history for one panel.\nTechnical metrics are always retained; other history categories can be disabled in the UI.' ;;
    ru:store_lite_only) _f='Lite-вариант хранит историю только в памяти. Для SQLite установите full: sh install.sh --variant full' ;;
    en:store_lite_only) _f='The lite variant stores history in memory only. For SQLite install full: sh install.sh --variant full' ;;
    ru:store_lite_existing) _f='Нельзя установить lite поверх конфигурации с хранилищем %s: lite поддерживает только memory. Текущая установка не изменена. Оставьте full или сначала осознанно перенесите состояние и конфиг на memory.' ;;
    en:store_lite_existing) _f='Cannot install lite over a configuration using the %s store: lite supports memory only. The current installation was not changed. Keep full, or deliberately migrate the state and configuration to memory first.' ;;

    # ── summary ──
    ru:s_version) _f='Версия панели' ;;
    en:s_version) _f='Panel version' ;;
    ru:s_variant) _f='Вариант' ;;
    en:s_variant) _f='Variant' ;;
    ru:s_storage) _f='Хранилище' ;;
    en:s_storage) _f='Storage' ;;
    ru:s_latest) _f='последняя стабильная' ;;
    en:s_latest) _f='latest stable' ;;
    ru:s_local_binary) _f='локальный файл %s' ;;
    en:s_local_binary) _f='local file %s' ;;
    ru:s_listen) _f='Адрес панели' ;;
    en:s_listen) _f='Panel address' ;;
    ru:s_admin) _f='Администратор' ;;
    en:s_admin) _f='Administrator' ;;
    ru:s_telemt_url) _f='Telemt API' ;;
    en:s_telemt_url) _f='Telemt API' ;;
    ru:s_auth) _f='Заголовок авторизации' ;;
    en:s_auth) _f='Authorization header' ;;
    ru:s_set) _f='задан' ;;
    en:s_set) _f='set' ;;
    ru:s_subpage) _f='Страница подписки' ;;
    en:s_subpage) _f='Subscription page' ;;
    ru:s_run_as) _f='Запуск от' ;;
    en:s_run_as) _f='Runs as' ;;
    ru:s_paths) _f='Пути' ;;
    en:s_paths) _f='Paths' ;;
    ru:s_service) _f='Сервис' ;;
    en:s_service) _f='Service' ;;
    ru:apply_q) _f='Применить?' ;;
    en:apply_q) _f='Apply?' ;;

    # ── apply ──
    ru:a_user_exists) _f='Пользователь %s уже есть' ;;
    en:a_user_exists) _f='User %s already exists' ;;
    ru:a_user_created) _f='Создан системный пользователь %s' ;;
    en:a_user_created) _f='Created system user %s' ;;
    ru:a_user_fail) _f='Не удалось создать пользователя %s. Создайте вручную и запустите скрипт снова.' ;;
    en:a_user_fail) _f='Could not create user %s. Create it manually and re-run the script.' ;;
    ru:a_group) _f='%s добавлен в группу %s (%s)' ;;
    en:a_group) _f='%s added to group %s (%s)' ;;
    ru:a_group_journal) _f='чтение системного журнала' ;;
    en:a_group_journal) _f='system journal access' ;;
    ru:a_group_telemt) _f='чтение конфига Telemt' ;;
    en:a_group_telemt) _f='reading the Telemt config' ;;
    ru:a_group_fail) _f='Не удалось добавить %s в группу %s — сделайте вручную: usermod -aG %s %s' ;;
    en:a_group_fail) _f='Could not add %s to group %s — do it manually: usermod -aG %s %s' ;;
    ru:a_dirs) _f='Каталоги %s и %s готовы' ;;
    en:a_dirs) _f='Directories %s and %s are ready' ;;
    ru:a_resolve) _f='Ищу последний релиз…' ;;
    en:a_resolve) _f='Looking up the latest release…' ;;
    ru:a_resolve_fail) _f='Не удалось узнать последний релиз (нет сети или GitHub недоступен).\nМожно указать версию явно: --version vX.Y.Z' ;;
    en:a_resolve_fail) _f='Could not determine the latest release (no network or GitHub unreachable).\nYou can pass a version explicitly: --version vX.Y.Z' ;;
    ru:a_download) _f='Скачиваю %s…' ;;
    en:a_download) _f='Downloading %s…' ;;
    ru:a_download_fail) _f='Не удалось скачать %s. Проверьте, что релиз %s существует и есть доступ к github.com.' ;;
    en:a_download_fail) _f='Could not download %s. Check that release %s exists and github.com is reachable.' ;;
    ru:a_checksum_ok) _f='Контрольная сумма совпала' ;;
    en:a_checksum_ok) _f='Checksum verified' ;;
    ru:a_checksum_fail) _f='Контрольная сумма не совпала! Файл повреждён или подменён — установка остановлена.' ;;
    en:a_checksum_fail) _f='Checksum mismatch! The file is corrupted or tampered with — stopping.' ;;
    ru:a_checksum_missing) _f='Не удалось получить файл контрольной суммы. Установка остановлена без замены бинарника.' ;;
    en:a_checksum_missing) _f='Could not obtain the checksum file. Installation stopped without replacing the binary.' ;;
    ru:a_extract_fail) _f='В архиве нет файла %s.' ;;
    en:a_extract_fail) _f='The archive does not contain %s.' ;;
    ru:a_installed_bin) _f='Установлен %s (%s)' ;;
    en:a_installed_bin) _f='Installed %s (%s)' ;;
    ru:a_hash_fail) _f='Не удалось вычислить хеш пароля (бинарь не запускается на этой системе?).' ;;
    en:a_hash_fail) _f='Could not hash the password (does the binary run on this system?).' ;;
    ru:a_config_written) _f='Конфиг записан: %s' ;;
    en:a_config_written) _f='Config written: %s' ;;
    ru:a_sudoers) _f='Политика sudo записана: %s' ;;
    en:a_sudoers) _f='Sudo policy written: %s' ;;
    ru:a_sudoers_invalid) _f='visudo отверг сгенерированный файл sudoers — установка остановлена.' ;;
    en:a_sudoers_invalid) _f='visudo rejected the generated sudoers file — stopping.' ;;
    ru:a_sudoers_removed) _f='Старая политика sudo удалена (панель работает от root)' ;;
    en:a_sudoers_removed) _f='Old sudo policy removed (the panel runs as root)' ;;
    ru:a_service) _f='Сервис %s зарегистрирован (%s)' ;;
    en:a_service) _f='Service %s registered (%s)' ;;
    ru:a_service_manual) _f='Не найден update-rc.d/chkconfig — включите автозапуск вручную для %s.' ;;
    en:a_service_manual) _f='Neither update-rc.d nor chkconfig found — enable %s at boot manually.' ;;
    ru:a_started) _f='Сервис запущен' ;;
    en:a_started) _f='Service started' ;;
    ru:a_not_started) _f='Сервис не запущен (--no-start). Запуск: %s' ;;
    en:a_not_started) _f='Service not started (--no-start). Start it with: %s' ;;
    ru:a_health_ok) _f='Панель отвечает на %s' ;;
    en:a_health_ok) _f='The panel responds at %s' ;;
    ru:a_health_fail) _f='Панель не ответила за %s с. Смотрите журнал: %s' ;;
    en:a_health_fail) _f='The panel did not respond within %s s. Check the log: %s' ;;
    ru:a_sysupgrade) _f='OpenWrt: чтобы конфиг пережил sysupgrade, добавьте строку %s в /etc/sysupgrade.conf' ;;
    en:a_sysupgrade) _f='OpenWrt: to keep the config across sysupgrade, add %s to /etc/sysupgrade.conf' ;;

    # ── done ──
    ru:done_open) _f='Откройте панель в браузере:' ;;
    en:done_open) _f='Open the panel in a browser:' ;;
    ru:done_login) _f='Логин: %s   Пароль: тот, что вы ввели (скрипт его не сохраняет)' ;;
    en:done_login) _f='Login: %s   Password: the one you entered (the script does not store it)' ;;
    ru:done_commands) _f='Полезные команды:' ;;
    en:done_commands) _f='Useful commands:' ;;
    ru:done_status) _f='статус' ;;
    en:done_status) _f='status' ;;
    ru:done_restart) _f='перезапуск' ;;
    en:done_restart) _f='restart' ;;
    ru:done_logs) _f='журнал' ;;
    en:done_logs) _f='logs' ;;
    ru:done_edit) _f='Настройки: отредактируйте %s и перезапустите сервис.' ;;
    en:done_edit) _f='Settings: edit %s and restart the service.' ;;
    ru:done_update) _f='Обновление: из раздела «Сервер» в панели или повторным запуском этого скрипта.' ;;
    en:done_update) _f='Updates: from the "Server" section in the panel, or by re-running this script.' ;;
    ru:done_uninstall) _f='Удаление: sh install.sh uninstall (конфиг остаётся) или purge (удалить всё).' ;;
    en:done_uninstall) _f='Removal: sh install.sh uninstall (keeps config) or purge (removes everything).' ;;

    # ── update / migrate ──
    ru:migrate_config_api_only) _f='Редактирование настроек Telemt в 1.x требует Config API. Старое значение config_edit_mode=file сохраняется только для совместимости; прямая запись файла не поддерживается.' ;;
    en:migrate_config_api_only) _f='Editing Telemt settings in 1.x requires the Config API. The legacy config_edit_mode=file value is preserved only for compatibility; direct file editing is not supported.' ;;

    # ── uninstall ──
    ru:uninstall_q) _f='Удалить сервис, бинарь и политику sudo? Конфиг и данные останутся.' ;;
    en:uninstall_q) _f='Remove the service, binary and sudo policy? Config and data are kept.' ;;
    ru:purge_q) _f='Удалить сервис, бинарник, sudoers, конфиг %s и данные %s? Системная учётная запись %s и внешние файлы сохранятся.' ;;
    en:purge_q) _f='Remove service, binary, sudoers, config %s and data %s? OS account %s and external files will be retained.' ;;
    ru:u_kept) _f='Сохранены: %s и %s. Полное удаление: sh install.sh purge' ;;
    en:u_kept) _f='Kept: %s and %s. Full removal: sh install.sh purge' ;;
    ru:u_purged) _f='Панель, конфиг и настроенный каталог данных удалены. Учётная запись ОС и внешние файлы сохранены.' ;;
    en:u_purged) _f='Panel, configuration and configured data directory removed. OS account and external files retained.' ;;
    ru:u_nothing) _f='Панель не установлена — удалять нечего' ;;
    en:u_nothing) _f='The panel is not installed — nothing to remove' ;;

    *) _f="$_k" ;;
  esac
  # shellcheck disable=SC2059
  printf "$_f" "$@"
}

# tl KEY [args…] — t() plus a trailing newline.
tl() {
  t "$@"
  printf '\n'
}

# ═════════════════════════════════════════════════════════════════════════════
#  Output helpers
# ═════════════════════════════════════════════════════════════════════════════

C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_RESET=""
setup_colors() {
  if [ "$COLOR" = 1 ] && [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m'); C_GREEN=$(printf '\033[32m')
    C_YELLOW=$(printf '\033[33m'); C_RED=$(printf '\033[31m'); C_CYAN=$(printf '\033[36m')
    C_RESET=$(printf '\033[0m')
  fi
}

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[ !! ]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[fail]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
blank() { printf '\n'; }

# step N KEY — section header.
step() {
  printf '\n%s── %s. %s ──%s\n\n' "$C_BOLD" "$1" "$(t "$2")" "$C_RESET"
}

# explain KEY [args…] — dimmed, indented explanation paragraph.
explain() {
  tl "$@" | while IFS= read -r _line; do
    printf '  %s%s%s\n' "$C_DIM" "$_line" "$C_RESET"
  done
}

# kv LABEL VALUE — aligned key/value row for detection and summary tables.
# Padding is computed in characters, not bytes, so Cyrillic labels line up.
kv() {
  _w=$(printf '%s' "$1" | LC_ALL=C tr -d '\200-\277' | wc -c)
  _pad=$((26 - _w))
  [ "$_pad" -gt 0 ] || _pad=1
  printf '  %s%*s%s\n' "$1" "$_pad" "" "$2"
}

# mask SECRET — "abc…xyz" for display, never the full value.
mask() {
  _s="$1"
  _n=${#_s}
  if [ "$_n" -le 6 ]; then
    printf '***'
  else
    printf '%s…%s' "$(printf '%s' "$_s" | cut -c1-3)" "$(printf '%s' "$_s" | tail -c 3)"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  Execution helpers (dry-run aware)
# ═════════════════════════════════════════════════════════════════════════════

cleanup() {
  if [ -n "$UPDATE_STAGED" ]; then $SUDO rm -f "$UPDATE_STAGED" || true; fi
  if [ -n "$UPDATE_RESTORE" ]; then $SUDO rm -f "$UPDATE_RESTORE" || true; fi
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
installer_exit() {
  _exit_code=$?
  if [ "$UPDATE_PENDING" = 1 ]; then
    _exit_code=1
    if ! restore_update; then warn "$(t update_restore_failed "$UPDATE_BACKUP")"; fi
  fi
  cleanup
  trap - EXIT
  exit "$_exit_code"
}
trap installer_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ensure_temp_dir() {
  if [ -z "$TEMP_DIR" ]; then
    TEMP_DIR=$(mktemp -d)
    TEMP_DIR=$(cd "$TEMP_DIR" && pwd)
    HTTP_BODY="$TEMP_DIR/http.body"
  fi
}

has() { command -v "$1" >/dev/null 2>&1; }

# run CMD… — privileged command; printed instead of executed under --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s+ %s%s\n' "$C_DIM" "$*" "$C_RESET"
    return 0
  fi
  # shellcheck disable=SC2086
  $SUDO "$@"
}

# run_try CMD… — like run, but silent; returns the command status.
run_try() {
  if [ "$DRY_RUN" = 1 ]; then
    run "$@"
    return 0
  fi
  # shellcheck disable=SC2086
  $SUDO "$@" >/dev/null 2>&1
}

# run_quiet CMD… — like run_try, but never fails the script.
run_quiet() {
  run_try "$@" || true
}

# owner_group USER — primary group name (falls back to USER under --dry-run
# when the account does not exist yet).
owner_group() {
  id -gn "$1" 2>/dev/null || printf '%s' "$1"
}

# write_root_file PATH MODE [OWNER] — stdin → PATH via install(1).
write_root_file() {
  _path="$1"; _mode="$2"; _owner="${3:-}"
  ensure_temp_dir
  _tmp="$TEMP_DIR/write.$$"
  cat >"$_tmp"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s--- would write %s (mode %s%s) ---%s\n' "$C_DIM" "$_path" "$_mode" "${_owner:+, owner $_owner}" "$C_RESET"
    printf '  [content omitted]\n'
    printf '  %s--- end ---%s\n' "$C_DIM" "$C_RESET"
    rm -f "$_tmp"
    return 0
  fi
  if [ -n "$_owner" ]; then
    $SUDO install -m "$_mode" -o "$_owner" -g "$(owner_group "$_owner")" "$_tmp" "$_path"
  else
    $SUDO install -m "$_mode" "$_tmp" "$_path"
  fi
  rm -f "$_tmp"
}

# ═════════════════════════════════════════════════════════════════════════════
#  Input helpers
# ═════════════════════════════════════════════════════════════════════════════

tty_available() {
  ( : </dev/tty ) 2>/dev/null
}

require_tty() {
  if [ "$ASSUME_YES" = 1 ]; then
    return 0
  fi
  tty_available || die "$(t no_tty "https://raw.githubusercontent.com/$REPO/main/install.sh")"
}

# read_tty VAR — one line from the terminal into VAR.
read_tty() {
  IFS= read -r _line </dev/tty || _line=""
  eval "$1=\"\$_line\""
}

# read_tty_secret VAR — like read_tty with echo disabled.
read_tty_secret() {
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r _line </dev/tty || _line=""
  stty echo </dev/tty 2>/dev/null || true
  printf '\n'
  eval "$1=\"\$_line\""
}

# ask VAR KEY DEFAULT — prompt with a default; --yes takes the default.
ask() {
  _var="$1"; _key="$2"; _def="$3"
  if [ "$ASSUME_YES" = 1 ]; then
    eval "$_var=\"\$_def\""
    return 0
  fi
  if [ -n "$_def" ]; then
    printf '%s%s%s [%s]: ' "$C_BOLD" "$(t "$_key")" "$C_RESET" "$_def"
  else
    printf '%s%s%s: ' "$C_BOLD" "$(t "$_key")" "$C_RESET"
  fi
  read_tty _val
  if [ -z "$_val" ]; then
    _val="$_def"
  fi
  eval "$_var=\"\$_val\""
}

# ask_secret VAR KEY — hidden input, no default echo.
ask_secret() {
  printf '%s%s%s: ' "$C_BOLD" "$(t "$2")" "$C_RESET"
  read_tty_secret "$1"
}

# ask_choice VAR KEY DEFAULT "1 2 3" — numbered menu; repeats until valid.
ask_choice() {
  _var="$1"; _key="$2"; _def="$3"; _opts="$4"
  if [ "$ASSUME_YES" = 1 ]; then
    eval "$_var=\"\$_def\""
    return 0
  fi
  while :; do
    printf '%s%s%s [%s]: ' "$C_BOLD" "$(t "$_key")" "$C_RESET" "$_def"
    read_tty _val
    if [ -z "$_val" ]; then
      _val="$_def"
    fi
    for _o in $_opts; do
      if [ "$_val" = "$_o" ]; then
        eval "$_var=\"\$_val\""
        return 0
      fi
    done
    warn "$(t invalid_choice "$_opts")"
  done
}

# confirm_yn DEFAULT KEY [args…] — yes/no question, Enter takes DEFAULT
# (yes|no); --yes answers DEFAULT too.
confirm_yn() {
  _d="$1"
  shift
  if [ "$ASSUME_YES" = 1 ]; then
    [ "$_d" = "yes" ]
    return
  fi
  if [ "$_d" = "yes" ]; then _hint=$(t yn_yes); else _hint=$(t yn_no); fi
  while :; do
    printf '%s%s%s %s ' "$C_BOLD" "$(t "$@")" "$C_RESET" "$_hint"
    read_tty _val
    case "$_val" in
      '') [ "$_d" = "yes" ]; return ;;
      y|Y|yes|YES|д|Д|да|Да) return 0 ;;
      n|N|no|NO|н|Н|нет|Нет) return 1 ;;
    esac
  done
}

# confirm KEY [args…] — confirm_yn with a "yes" default.
confirm() {
  confirm_yn yes "$@"
}

# confirm_danger KEY [args…] — destructive step: Enter means "no", but an
# explicit --yes still means yes.
confirm_danger() {
  if [ "$ASSUME_YES" = 1 ]; then
    return 0
  fi
  confirm_yn no "$@"
}

# yesno_from STRING — normalises yes/no/да/нет/1/0 → "yes" | "no".
yesno_from() {
  case "$1" in
    y|Y|yes|YES|Yes|д|Д|да|Да|1|true) printf 'yes' ;;
    *) printf 'no' ;;
  esac
}

# ═════════════════════════════════════════════════════════════════════════════
#  Small utilities
# ═════════════════════════════════════════════════════════════════════════════

# toml_value FILE SECTION KEY — minimal reader for flat TOML sections; SECTION
# is the literal header without brackets ("" for top-level, "server.api" for
# nested). Strips quotes and trailing comments.
toml_value() {
  _file="$1"; _section="$2"; _key="$3"
  [ -f "$_file" ] || return 0
  awk -v section="[$_section]" -v key="$_key" '
    BEGIN { in_section = (section == "[]") }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[/ {
      line = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      in_section = (line == section)
      next
    }
    in_section {
      line = $0
      eq = index(line, "=")
      if (eq == 0) next
      current_key = substr(line, 1, eq - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", current_key)
      if (current_key != key) next
      value = substr(line, eq + 1)
      gsub(/^[[:space:]]+/, "", value)
      if (substr(value, 1, 1) == "\"") {
        value = substr(value, 2)
        sub(/"[^"]*$/, "", value)
      } else {
        sub(/[[:space:]]*#.*$/, "", value)
        gsub(/[[:space:]]+$/, "", value)
      }
      print value
      exit
    }
  ' "$_file"
}

# toml_escape STRING — escape for a double-quoted TOML string.
toml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# gen_secret — 64 hex chars from openssl or /dev/urandom.
gen_secret() {
  if has openssl; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# gen_password — 16 alphanumerics from /dev/urandom.
gen_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16
}

# http_get URL [AUTH_HEADER] — body → $HTTP_BODY, prints the HTTP status
# ("000" when the connection failed). Authenticated probes require curl 7.55+;
# wget has no portable way to keep a header token out of its process arguments.
http_get() {
  _url="$1"; _hdr="${2:-}"
  ensure_temp_dir
  : >"$HTTP_BODY"
  if has curl; then
    if [ -n "$_hdr" ]; then
      # Reject line injection: @- interprets each input line as a separate header.
      if [ "$(printf '%s' "$_hdr" | tr -d '\r\n')" != "$_hdr" ]; then printf '000'; return 0; fi
      _code=$(printf 'Authorization: %s\n' "$_hdr" | curl -s -m 8 -o "$HTTP_BODY" -w '%{http_code}' -H @- "$_url" 2>/dev/null) || _code="000"
    else
      _code=$(curl -s -m 8 -o "$HTTP_BODY" -w '%{http_code}' "$_url" 2>/dev/null) || _code="000"
    fi
    printf '%s' "${_code:-000}"
    return 0
  fi
  if [ -n "$_hdr" ]; then
    printf '000'
    return 0
  fi
  _err="$TEMP_DIR/http.err"
  wget -q -T 8 -O "$HTTP_BODY" -S "$_url" >"$_err" 2>&1 && _rc=0 || _rc=$?
  _code=$(grep -o 'HTTP/[0-9.]* [0-9][0-9][0-9]' "$_err" | tail -n 1 | awk '{print $2}')
  if [ -n "$_code" ]; then
    printf '%s' "$_code"
  elif [ "$_rc" = 0 ]; then
    printf '200'
  else
    printf '000'
  fi
}

# download URL DEST — file download with a progress bar where supported.
download() {
  if has curl; then
    curl -fL --progress-bar -o "$2" "$1"
  else
    wget -O "$2" "$1"
  fi
}

# sha256_of FILE — hex digest via whichever tool exists ("" if none).
sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif has sha256; then
    sha256 -q "$1"
  elif has openssl; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

# json_field FILE KEY — first string value of "KEY" in a JSON file.
json_field() {
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
}

# host_port_split HOSTPORT — sets SPLIT_HOST and SPLIT_PORT; returns 1 if
# the value does not look like host:port.
host_port_split() {
  case "$1" in
    *:*) ;;
    *) return 1 ;;
  esac
  SPLIT_PORT=${1##*:}
  SPLIT_HOST=${1%:*}
  case "$SPLIT_PORT" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$SPLIT_PORT" -ge 1 ] 2>/dev/null && [ "$SPLIT_PORT" -le 65535 ] 2>/dev/null || return 1
  return 0
}

# port_in_use PORT — 0 when something already listens on it.
port_in_use() {
  if has ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"
  elif has netstat; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"
  else
    return 1
  fi
}

# health_url LISTEN — loopback URL for the panel's /api/health.
health_url() {
  host_port_split "$1" || return 1
  case "$SPLIT_HOST" in
    ''|0.0.0.0|'[::]'|'::') _h="127.0.0.1" ;;
    *) _h="$SPLIT_HOST" ;;
  esac
  printf 'http://%s:%s/api/health' "$_h" "$SPLIT_PORT"
}

# host_addresses — one IPv4 per line for the "open in browser" hint.
host_addresses() {
  if has hostname && hostname -I >/dev/null 2>&1; then
    hostname -I | tr ' ' '\n' | grep -v '^$' | grep -v '^127\.' | head -n 3
  elif has ip; then
    ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 3
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  Detection
# ═════════════════════════════════════════════════════════════════════════════

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    armv7*|armv8l) ARCH="armv7" ;;
    mipsel|mipsle) ARCH="mipsle" ;;
    mips) ARCH="mips" ;;
    *) die "$(t unsupported_arch "$(uname -m)")" ;;
  esac
}

# Mirrors internal/update/variant.go: Alpine/OpenWrt markers, then ldd.
detect_libc() {
  if [ -f /etc/alpine-release ] || [ -f /etc/openwrt_release ]; then
    LIBC="musl"
    return 0
  fi
  _ldd=$(ldd --version 2>&1 || true)
  case "$_ldd" in
    *musl*) LIBC="musl" ;;
    *GNU*|*gnu*|*glibc*|*GLIBC*) LIBC="gnu" ;;
    *) LIBC="musl" ;;
  esac
}

# Same order as internal/host/detect.go; procd (OpenWrt) has no rc-service,
# so checking OpenRC before it is safe.
detect_init() {
  if [ -d /run/systemd/system ]; then
    INIT="systemd"
  elif [ -d /run/openrc ] || has rc-service; then
    INIT="openrc"
  elif [ -f /etc/openwrt_release ]; then
    INIT="procd"
  elif [ -d /etc/init.d ]; then
    INIT="sysvinit"
  else
    INIT="none"
  fi
}

# Router layout: /usr/bin and a RAM-backed data_dir (flash wear).
apply_layout() {
  if [ "$INIT" = "procd" ]; then
    BIN_DIR="/usr/bin"
    DATA_DIR="/tmp/telemt-panel"
  fi
  PANEL_BIN="$BIN_DIR/$BINARY_NAME"
  if [ -n "${TP_DATA_DIR:-}" ]; then
    DATA_DIR="$TP_DATA_DIR"
  fi
  case "$INIT" in
    systemd) SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service" ;;
    *) SERVICE_FILE="/etc/init.d/$SERVICE_NAME" ;;
  esac
}

detect_tools() {
  HAS_SUDO=0
  has sudo && HAS_SUDO=1
  HAS_USERADD=0
  if has useradd || has adduser; then
    HAS_USERADD=1
  fi
  if has apt-get; then PKG="apt"
  elif has apk; then PKG="apk"
  elif has opkg; then PKG="opkg"
  elif has dnf; then PKG="dnf"
  elif has yum; then PKG="yum"
  else PKG="unknown"
  fi
}

# install_hint CMD — the package-manager one-liner for a missing tool.
install_hint() {
  case "$PKG" in
    apt) printf 'apt-get install -y %s' "$1" ;;
    apk) printf 'apk add %s' "$1" ;;
    opkg) printf 'opkg update && opkg install %s' "$1" ;;
    dnf) printf 'dnf install -y %s' "$1" ;;
    yum) printf 'yum install -y %s' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}


detect_telemt() {
  TELEMT_BIN_DETECTED=""
  for _c in /bin/telemt /usr/bin/telemt /usr/local/bin/telemt /opt/bin/telemt/telemt; do
    if [ -x "$_c" ]; then
      TELEMT_BIN_DETECTED="$_c"
      break
    fi
  done

  TELEMT_SVC_DETECTED=""
  case "$INIT" in
    systemd)
      if systemctl list-unit-files telemt.service 2>/dev/null | grep -q '^telemt\.service'; then
        TELEMT_SVC_DETECTED="telemt"
      fi ;;
    *)
      if [ -x /etc/init.d/telemt ]; then
        TELEMT_SVC_DETECTED="telemt"
      fi ;;
  esac

  TELEMT_URL_DETECTED=""
  TELEMT_AUTH_DETECTED=""
  TELEMT_API_ENABLED=""
  if [ -r "$TELEMT_CONFIG" ] || { [ -n "$SUDO" ] && [ -f "$TELEMT_CONFIG" ]; }; then
    ensure_temp_dir
    _copy="$TEMP_DIR/telemt.toml"
    if [ -r "$TELEMT_CONFIG" ]; then
      cat "$TELEMT_CONFIG" >"$_copy"
    else
      # shellcheck disable=SC2024  # the redirect target is ours, not root's
      sudo -n cat "$TELEMT_CONFIG" >"$_copy" 2>/dev/null || : >"$_copy"
    fi
    TELEMT_API_ENABLED=$(toml_value "$_copy" server.api enabled)
    TELEMT_AUTH_DETECTED=$(toml_value "$_copy" server.api auth_header)
    _listen=$(toml_value "$_copy" server.api listen)
    if [ -n "$_listen" ] && host_port_split "$_listen"; then
      case "$SPLIT_HOST" in
        ''|0.0.0.0|'[::]'|'::') _h="127.0.0.1" ;;
        *) _h="$SPLIT_HOST" ;;
      esac
      TELEMT_URL_DETECTED="http://$_h:$SPLIT_PORT"
    fi
    rm -f "$_copy"
  fi
}

detect_all() {
  detect_arch
  detect_libc
  detect_init
  apply_layout
  detect_tools
  # Installation/update defers schema recognition to the verified Go parser.
  EXISTING="none"
  # The service owns a 0750 config directory; the invoking sudo user may not
  # be able to stat its contents. A hidden file must never mean a fresh install.
  if $SUDO test -e "$CONFIG_FILE" || $SUDO test -L "$CONFIG_FILE"; then EXISTING="present"; fi
  detect_telemt
  choose_build_variant
}

choose_build_variant() {
  _requested="${BUILD_VARIANT:-${TP_VARIANT:-}}"
  if [ -n "$_requested" ]; then VARIANT_EXPLICIT=1; fi
  # Never execute an unverified installed binary; 0.6 treats 'version' as startup.
  if [ -z "$_requested" ]; then
    case "$INIT:$ARCH" in
      procd:*|*:mips|*:mipsle) _requested="lite" ;;
      *) _requested="full" ;;
    esac
  fi
  case "$_requested" in
    full|lite) BUILD_VARIANT="$_requested" ;;
    *) die "$(t unknown_option "--variant $_requested")" ;;
  esac
  case "$BUILD_VARIANT:$ARCH" in
    full:mips|full:mipsle) die "$(t unsupported_arch "$ARCH (full)")" ;;
  esac
  if [ -z "$STORE_DRIVER" ]; then
    if [ "$BUILD_VARIANT" = "lite" ]; then STORE_DRIVER="memory"; else STORE_DRIVER="sqlite"; fi
  fi
}

print_detection() {
  kv "$(t d_arch)" "$ARCH ($LIBC)"
  kv "$(t d_variant)" "$BUILD_VARIANT"
  kv "$(t d_init)" "$INIT"
  if [ "$HAS_SUDO" = 1 ]; then
    kv "$(t d_sudo)" "$(t d_available)"
  else
    kv "$(t d_sudo)" "$(t d_missing)"
  fi
  case "$EXISTING" in
    present) kv "$(t d_existing)" "$(t existing_config "$CONFIG_FILE")" ;;
    none) kv "$(t d_existing)" "$(t d_existing_none)" ;;
  esac
}

print_telemt_detection() {
  kv "$(t d_telemt_bin)" "${TELEMT_BIN_DETECTED:-$(t d_missing)}"
  kv "$(t d_telemt_svc)" "${TELEMT_SVC_DETECTED:-$(t d_missing)}"
  if [ -f "$TELEMT_CONFIG" ]; then
    kv "$(t d_telemt_cfg)" "$TELEMT_CONFIG"
  else
    kv "$(t d_telemt_cfg)" "$(t d_missing)"
  fi
  if [ "$TELEMT_API_ENABLED" = "false" ]; then
    kv "$(t d_telemt_api)" "$(t d_api_disabled)"
  elif [ -n "$TELEMT_URL_DETECTED" ]; then
    kv "$(t d_telemt_api)" "$TELEMT_URL_DETECTED"
  else
    kv "$(t d_telemt_api)" "$(t d_api_unknown)"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  Generators
# ═════════════════════════════════════════════════════════════════════════════

# restart_cmd SERVICE — the exact argv the panel's ServiceManager runs,
# with absolute paths as sudoers requires.
restart_cmd() {
  case "$INIT" in
    systemd) printf '%s restart %s' "$(command -v systemctl)" "$1" ;;
    openrc) printf '%s %s restart' "$(command -v rc-service)" "$1" ;;
    procd|sysvinit) printf '/etc/init.d/%s restart' "$1" ;;
  esac
}

# restart_display SERVICE — the same command as typed by a human.
restart_display() {
  case "$INIT" in
    systemd) printf 'systemctl restart %s' "$1" ;;
    openrc) printf 'rc-service %s restart' "$1" ;;
    procd|sysvinit) printf '/etc/init.d/%s restart' "$1" ;;
  esac
}

# gen_config — the 1.x config from the answer globals, on stdout. The
# EXTRA_* globals carry per-section lines that only a migrated 0.x config
# contributes (base_path, session_ttl, …); they are empty otherwise.
EXTRA_TOP=""; EXTRA_TELEMT=""; EXTRA_AUTH=""; EXTRA_HOST=""; EXTRA_UPDATES=""
emit_extra() {
  [ -n "$1" ] && printf '%s\n' "$1"
  return 0
}
gen_config() {
  _mode="direct"
  if [ "$RUN_AS" = "user" ]; then
    _mode="sudo"
  fi
  _sub="false"
  if [ "$SUBPAGE_ENABLED" = "yes" ]; then
    _sub="true"
  fi
  _store_driver="${STORE_DRIVER:-sqlite}"
  if [ "$INIT" = "procd" ]; then
    _store_driver="memory"
  fi
  _store_detail_line=""
  case "$_store_driver" in
    sqlite) _store_detail_line="path = \"$(toml_escape "$DATA_DIR/panel.db")\"" ;;
  esac
  if [ "$L" = "ru" ]; then
    _c_top="# Параметры запуска панели. Настройки интерфейса хранятся отдельно в panel-state.json."
    _c_listen="# Адрес панели. За reverse proxy на подпути добавьте base_path = \"/panel\"."
    _c_data="# Каталог состояния (сессии, журнал обновлений). Пусто — только RAM."
    _c_telemt="# Telemt HTTP API: [server.api] в конфиге Telemt."
    _c_auth="# Хеш пароля: telemt-panel hash-password"
    _c_sub="# Страница подписки /sub/<token>. secret — ключ HMAC для токенов."
    _c_host="# Имена сервисов для рестарта и чтения журнала (auto-детект init-системы)."
    _c_upd="# Пути бинарей, которые заменяет обновление из панели."
    _c_priv="# sudo — узкая политика в $SUDOERS_FILE; direct — панель работает от root."
  else
    _c_top="# Panel startup parameters. UI settings are stored separately in panel-state.json."
    _c_listen="# Panel address. Behind a reverse proxy on a sub-path add base_path = \"/panel\"."
    _c_data="# State directory (sessions, update journal). Empty keeps state in RAM only."
    _c_telemt="# Telemt HTTP API: [server.api] in the Telemt config."
    _c_auth="# Password hash: telemt-panel hash-password"
    _c_sub="# Subscription page /sub/<token>. secret is the HMAC key for tokens."
    _c_host="# Service names for restarts and log reading (init system is auto-detected)."
    _c_upd="# Binary paths replaced by updates started from the panel."
    _c_priv="# sudo — narrow policy in $SUDOERS_FILE; direct — the panel runs as root."
  fi
  cat <<EOF
# telemt-panel 1.x — generated by install.sh $(date +%Y-%m-%d)
$_c_top

$_c_listen
listen = "$(toml_escape "$LISTEN")"

$_c_data
data_dir = "$(toml_escape "$DATA_DIR")"
EOF
  emit_extra "$EXTRA_TOP"
  gen_tls_config
  cat <<EOF

[telemt]
$_c_telemt
url = "$(toml_escape "$TELEMT_URL")"
auth_header = "$(toml_escape "$TELEMT_AUTH")"
EOF
  emit_extra "$EXTRA_TELEMT"
  cat <<EOF

[auth]
username = "$(toml_escape "$ADMIN_USER")"
$_c_auth
password_hash = "$(toml_escape "$PASS_HASH")"
EOF
  emit_extra "$EXTRA_AUTH"
  cat <<EOF

[store]
driver = "$_store_driver"
$_store_detail_line

[subpage]
$_c_sub
enabled = $_sub
secret = "$(toml_escape "$SUBPAGE_SECRET")"

[host]
$_c_host
telemt_service = "$(toml_escape "$TELEMT_SVC")"
panel_service = "$SERVICE_NAME"
EOF
  emit_extra "$EXTRA_HOST"
  cat <<EOF

[updates]
$_c_upd
telemt_binary_path = "$(toml_escape "$TELEMT_BIN")"
panel_binary_path = "$(toml_escape "$PANEL_BIN")"
EOF
  emit_extra "$EXTRA_UPDATES"
  cat <<EOF

[privileges]
$_c_priv
mode = "$_mode"
EOF
}

# sudoers_path_ok PATH — allow literal paths, not sudoers patterns or syntax.
sudoers_path_ok() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[!a-zA-Z0-9_./-]*) return 1 ;;
  esac
  return 0
}

service_name_ok() {
  case "$1" in
    ''|-*|.|..|*[!a-zA-Z0-9_.@-]*) return 1 ;;
  esac
  return 0
}

validate_service_names() {
  for _service in "$SERVICE_NAME" "$TELEMT_SVC"; do
    service_name_ok "$_service" || die "$(t unsafe_service "$_service")"
  done
}

# gen_sudoers — exactly the commands the panel probes with `sudo -n -l` at
# startup (httpapi.updatePrivilegeProbeOps × host.SudoRunner) plus the
# restart argv of the detected ServiceManager. No wildcards.
gen_sudoers() {
  validate_service_names
  _cp=$(command -v cp); _chmod=$(command -v chmod); _mv=$(command -v mv)
  _staging="$DATA_DIR/staging"
  for _p in "$_cp" "$_chmod" "$_mv" "$_staging" "$TELEMT_BIN" "$PANEL_BIN"; do
    sudoers_path_ok "$_p" || die "$(t unsafe_sudoers_path "$_p")"
  done
  printf '# telemt-panel: update engine privileges (generated by install.sh)\n'
  printf '# Every line matches an exact argv the panel executes; edit with care.\n'
  for _pair in "telemt:$TELEMT_BIN" "panel:$PANEL_BIN"; do
    _target=${_pair%%:*}
    _bin=${_pair#*:}
    cat <<EOF
$SYSTEM_USER ALL=(root) NOPASSWD: $_cp -f $_staging/runs/$_target/backup $_bin.bak.tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_chmod 0755 $_bin.bak.tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_mv -f $_bin.bak.tmp $_bin.bak
$SYSTEM_USER ALL=(root) NOPASSWD: $_cp -f $_staging/runs/$_target/bin $_bin.tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_cp -f $_bin.bak $_bin.tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_chmod 0755 $_bin.tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_mv -f $_bin.tmp $_bin
EOF
  done
  printf '%s ALL=(root) NOPASSWD: %s\n' "$SYSTEM_USER" "$(restart_cmd "$TELEMT_SVC")"
  printf '%s ALL=(root) NOPASSWD: %s\n' "$SYSTEM_USER" "$(restart_cmd "$SERVICE_NAME")"
}

gen_service_systemd() {
  cat <<EOF
[Unit]
Description=Telemt Panel
After=network.target

[Service]
Type=simple
EOF
  if [ "$RUN_AS" = "user" ]; then
    printf 'User=%s\n' "$SYSTEM_USER"
    if needs_bind_capability; then
      printf 'AmbientCapabilities=CAP_NET_BIND_SERVICE\n'
    fi
  fi
  cat <<EOF
ExecStart=$PANEL_BIN --config $CONFIG_FILE
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

# Hardening compatible with sudo-based update operations
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$CONFIG_DIR $DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
}

gen_service_openrc() {
  cat <<EOF
#!/sbin/openrc-run
# Telemt Panel (generated by install.sh)

name="Telemt Panel"
command="$PANEL_BIN"
command_args="--config $CONFIG_FILE"
command_background="yes"
pidfile="/run/$SERVICE_NAME.pid"
output_log="$LOG_FILE"
error_log="$LOG_FILE"
EOF
  if [ "$RUN_AS" = "user" ]; then
    printf 'command_user="%s:%s"\n' "$SYSTEM_USER" "$SYSTEM_USER"
  fi
  cat <<'EOF'

depend() {
	need net
	after firewall
}
EOF
}

gen_service_procd() {
  cat <<EOF
#!/bin/sh /etc/rc.common
# Telemt Panel (generated by install.sh)

USE_PROCD=1
START=95
STOP=10

start_service() {
	procd_open_instance
	procd_set_param command $PANEL_BIN --config $CONFIG_FILE
	procd_set_param respawn 3600 5 5
	procd_set_param stdout 1
	procd_set_param stderr 1
	procd_close_instance
}
EOF
}

gen_service_sysvinit() {
  _chuid=""
  if [ "$RUN_AS" = "user" ]; then
    _chuid="--chuid $SYSTEM_USER"
  fi
  cat <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          $SERVICE_NAME
# Required-Start:    \$network \$remote_fs
# Required-Stop:     \$network \$remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Telemt Panel
### END INIT INFO
# Generated by install.sh

DAEMON="$PANEL_BIN"
DAEMON_ARGS="--config $CONFIG_FILE"
PIDFILE="/run/$SERVICE_NAME.pid"
LOGFILE="$LOG_FILE"
CHUID="$_chuid"

start() {
	echo "Starting $SERVICE_NAME"
	start-stop-daemon --start --background --no-close --make-pidfile --pidfile "\$PIDFILE" \\
		\$CHUID --exec "\$DAEMON" -- \$DAEMON_ARGS >>"\$LOGFILE" 2>&1
}

stop() {
	echo "Stopping $SERVICE_NAME"
	start-stop-daemon --stop --retry 10 --pidfile "\$PIDFILE"
	rm -f "\$PIDFILE"
}

case "\$1" in
	start) start ;;
	stop) stop ;;
	restart) stop; start ;;
	status)
		if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then
			echo "$SERVICE_NAME is running"
		else
			echo "$SERVICE_NAME is stopped"
			exit 3
		fi ;;
	*) echo "Usage: \$0 {start|stop|restart|status}"; exit 1 ;;
esac
EOF
}

gen_service() {
  case "$INIT" in
    systemd) gen_service_systemd ;;
    openrc) gen_service_openrc ;;
    procd) gen_service_procd ;;
    sysvinit) gen_service_sysvinit ;;
  esac
}

# Per-init command lines shown to the user.
cmd_status()  { case "$INIT" in systemd) printf 'systemctl status %s' "$SERVICE_NAME" ;; openrc) printf 'rc-service %s status' "$SERVICE_NAME" ;; *) printf '/etc/init.d/%s status' "$SERVICE_NAME" ;; esac; }
cmd_restart() { restart_display "$SERVICE_NAME"; }
cmd_logs()    { case "$INIT" in systemd) printf 'journalctl -u %s -f' "$SERVICE_NAME" ;; procd) printf 'logread -f -e %s' "$SERVICE_NAME" ;; *) printf 'tail -f %s' "$LOG_FILE" ;; esac; }

# ═════════════════════════════════════════════════════════════════════════════
#  Prerequisites
# ═════════════════════════════════════════════════════════════════════════════

check_prereqs() {
  if [ "$(id -u)" -ne 0 ]; then
    has sudo || die "$(t need_root)"
    SUDO="sudo"
    if [ "$DRY_RUN" != 1 ]; then
      say "$(t sudo_check)"
      sudo -v || die "$(t need_root)"
    fi
  fi
  if ! has curl && ! has wget; then
    die "$(t missing_cmd curl "$(install_hint curl)")"
  fi
  has tar || die "$(t missing_cmd tar "$(install_hint tar)")"
  if [ -z "$BINARY_FILE" ] && ! has sha256sum && ! has sha256 && ! has openssl; then
    die "$(t no_sha)"
  fi
  ok "$(t prereq_ok)"
}

# ═════════════════════════════════════════════════════════════════════════════
#  Questions
# ═════════════════════════════════════════════════════════════════════════════

# check_telemt_api URL HEADER — prints a status, never the header value.
check_telemt_api() {
  if [ -n "$2" ] && ! has curl; then printf 'needs-curl'; return 0; fi
  _code=$(http_get "$1/v1/health" "$2")
  case "$_code" in
    200)
      _ver=$(json_field "$HTTP_BODY" version)
      printf 'ok %s' "${_ver:-HTTP 200}" ;;
    401|403) printf 'auth %s' "$_code" ;;
    000) printf 'refused' ;;
    *) printf 'other %s' "$_code" ;;
  esac
}

ask_telemt_connection() {
  _first=1
  while :; do
    [ "$_first" = 1 ] || blank
    _first=0
    explain x_telemt_url "$TELEMT_CONFIG"
    ask TELEMT_URL q_telemt_url "${TP_TELEMT_URL:-${TELEMT_URL_DETECTED:-http://127.0.0.1:9091}}"
    TELEMT_URL=${TELEMT_URL%/}

    blank
    explain x_auth
    _def_auth="${TP_TELEMT_AUTH_HEADER:-$TELEMT_AUTH_DETECTED}"
    if [ "$ASSUME_YES" = 1 ]; then
      TELEMT_AUTH="$_def_auth"
    else
      if [ -n "$_def_auth" ]; then
        printf '  %s%s%s\n' "$C_DIM" "$(t auth_detected "$(mask "$_def_auth")")" "$C_RESET"
      else
        printf '  %s%s%s\n' "$C_DIM" "$(t auth_detected "$(t auth_empty)")" "$C_RESET"
      fi
      ask_secret _in q_auth
      if [ -n "$_in" ]; then
        TELEMT_AUTH="$_in"
      else
        TELEMT_AUTH="$_def_auth"
      fi
    fi

    while :; do
      blank
      say "$(t checking_api)"
      _res=$(check_telemt_api "$TELEMT_URL" "$TELEMT_AUTH")
      case "$_res" in
        ok\ *) ok "$(t api_ok "${_res#ok }")"; return 0 ;;
        auth\ *) warn "$(t api_auth "${_res#auth }" "$TELEMT_CONFIG")" ;;
        refused) warn "$(t api_refused "$TELEMT_URL")" ;;
        other\ *) warn "$(t api_other "${_res#other }")" ;;
        needs-curl) warn "$(t api_needs_curl)" ;;
      esac
      if [ "$ASSUME_YES" = 1 ]; then
        return 0
      fi
      ask_choice _c api_retry_q 1 "1 2 3"
      case "$_c" in
        1) continue ;;
        2) break ;;
        3) return 0 ;;
      esac
    done
  done
}

gen_tls_config() {
  printf '\n[tls]\nmode = "%s"\n' "$TLS_MODE"
  case "$TLS_MODE" in
    acme)
      printf 'acme_domain = "%s"\nacme_cache_dir = "%s"\n' "$(toml_escape "$TLS_DOMAIN")" "$(toml_escape "${TLS_CACHE:-$CONFIG_DIR/certs}")" ;;
    certificate)
      printf 'cert_file = "%s"\nkey_file = "%s"\n' "$(toml_escape "$TLS_CERT")" "$(toml_escape "$TLS_KEY")" ;;
  esac
}


tls_domain_ok() {
  case "$1" in ''|*[!A-Za-z0-9.-]*) return 1 ;; esac
  printf '%s\n' "$1" | awk '
    length($0) > 253 || $0 !~ /\./ || $0 ~ /^[0-9.]+$/ { exit 1 }
    { n=split($0, labels, "."); for (i=1;i<=n;i++) {
      if (length(labels[i]) < 1 || length(labels[i]) > 63 || labels[i] !~ /^[A-Za-z0-9-]+$/ || labels[i] ~ /^-/ || labels[i] ~ /-$/) exit 1
    } }'
}

ask_transport() {
  _default=1
  _transport="${TP_TLS_MODE:-}"
  if [ "$ASSUME_YES" = 1 ] && [ -z "$_transport" ]; then _transport=http; fi
  case "$_transport" in
    ''|acme) _default=1 ;; certificate) _default=2 ;; proxy) _default=3 ;; http) _default=4 ;;
    *) die "$(t unknown_option TP_TLS_MODE)" ;;
  esac
  ask_choice _tls_choice q_transport "$_default" "1 2 3 4"
  TLS_DOMAIN=""; TLS_CERT=""; TLS_KEY=""; TLS_CACHE=""
  # shellcheck disable=SC2154
  case "$_tls_choice" in
    1)
      TLS_MODE=acme; LISTEN="0.0.0.0:8443"
      TLS_CACHE="${TP_TLS_CACHE_DIR:-$CONFIG_DIR/certs}"
      explain tls_acme_notice
      ask TLS_DOMAIN q_tls_domain "${TP_TLS_DOMAIN:-}"
      tls_domain_ok "$TLS_DOMAIN" || die "$(t tls_bad_domain)"
      TLS_DOMAIN=$(printf '%s' "$TLS_DOMAIN" | tr '[:upper:]' '[:lower:]') ;;
    2)
      TLS_MODE=certificate; LISTEN="0.0.0.0:8443"
      ask TLS_CERT q_tls_cert "${TP_TLS_CERT_FILE:-}"
      ask TLS_KEY q_tls_key "${TP_TLS_KEY_FILE:-}"
      if [ ! -r "$TLS_CERT" ] || [ ! -r "$TLS_KEY" ]; then die "$(t tls_cert_unreadable)"; fi ;;
    3) TLS_MODE=http; LISTEN="127.0.0.1:8080"; explain tls_proxy_notice ;;
    4) TLS_MODE=http; LISTEN="0.0.0.0:8080"; warn "$(t tls_http_notice)" ;;
  esac
}

needs_bind_capability() {
  [ "$TLS_MODE" = acme ] && return 0
  host_port_split "$LISTEN" || return 1
  [ "$SPLIT_PORT" -lt 1024 ]
}

validate_transport_rights() {
  if [ "$RUN_AS" = user ] && [ "$INIT" != systemd ] && needs_bind_capability; then
    die "$(t tls_bind_rights)"
  fi
  if [ "$TLS_MODE" = acme ] && host_port_split "$LISTEN" && [ "$SPLIT_PORT" -eq 80 ]; then
    die "$(t bad_listen)"
  fi
}

ask_listen() {
  blank
  explain x_listen
  while :; do
    ask LISTEN q_listen "${TP_LISTEN:-$LISTEN}"
    if host_port_split "$LISTEN"; then
      break
    fi
    warn "$(t bad_listen)"
    if [ "$ASSUME_YES" = 1 ]; then
      exit 1
    fi
  done
  if port_in_use "$SPLIT_PORT"; then
    warn "$(t port_busy "$SPLIT_PORT")"
  fi
}

# shellcheck disable=SC2154  # _p1/_p2 are assigned through ask_secret's eval
ask_admin() {
  blank
  explain x_admin_user
  ask ADMIN_USER q_admin_user "${TP_ADMIN_USER:-admin}"

  blank
  explain x_password
  if [ "$ASSUME_YES" = 1 ]; then
    ADMIN_PASS="${TP_ADMIN_PASSWORD:-}"
    [ -n "$ADMIN_PASS" ] || die "$(t missing_env TP_ADMIN_PASSWORD)"
    return 0
  fi
  while :; do
    ask_secret _p1 q_password
    if [ "$_p1" = "g" ]; then
      ADMIN_PASS=$(gen_password)
      printf '  %s%s%s\n' "$C_BOLD" "$(t pass_generated "$ADMIN_PASS")" "$C_RESET"
      return 0
    fi
    if [ "${#_p1}" -lt 8 ]; then
      warn "$(t pass_short)"
      continue
    fi
    ask_secret _p2 q_password_again
    if [ "$_p1" != "$_p2" ]; then
      warn "$(t pass_mismatch)"
      continue
    fi
    ADMIN_PASS="$_p1"
    return 0
  done
}

ask_subpage() {
  blank
  explain x_subpage
  _def=$(yesno_from "${TP_SUBPAGE:-yes}")
  if confirm_yn "$_def" q_subpage; then SUBPAGE_ENABLED="yes"; else SUBPAGE_ENABLED="no"; fi
}

ask_telemt_paths() {
  blank
  explain x_telemt_bin
  ask TELEMT_BIN q_telemt_bin "${TP_TELEMT_BINARY:-${TELEMT_BIN_DETECTED:-/bin/telemt}}"
  blank
  explain x_telemt_svc "$(restart_display telemt)"
  ask TELEMT_SVC q_telemt_svc "${TP_TELEMT_SERVICE:-${TELEMT_SVC_DETECTED:-telemt}}"
}

ask_run_as() {
  blank
  if [ "$INIT" = "procd" ]; then
    RUN_AS="root"
    explain run_as_forced_procd
    return 0
  fi
  if [ "$HAS_SUDO" != 1 ] || [ "$HAS_USERADD" != 1 ]; then
    RUN_AS="root"
    explain run_as_forced_nosudo
    return 0
  fi
  explain x_run_as "$SYSTEM_USER" "$SUDOERS_FILE"
  _def=1
  case "${TP_RUN_AS:-user}" in
    root) _def=2 ;;
  esac
  ask_choice _c q_run_as "$_def" "1 2"
  if [ "$_c" = 2 ]; then RUN_AS="root"; else RUN_AS="user"; fi
}

ask_storage() {
  blank
  if [ "$BUILD_VARIANT" = "lite" ]; then
    STORE_DRIVER="memory"
    explain store_lite_only
    return 0
  fi
  explain x_storage
  _default=1
  case "${TP_STORE_DRIVER:-sqlite}" in
    sqlite) _default=1 ;;
    memory) _default=2 ;;
    *) die "$(t unknown_option "TP_STORE_DRIVER=${TP_STORE_DRIVER:-}")" ;;
  esac
  ask_choice _store_choice q_storage "$_default" "1 2"
  # shellcheck disable=SC2154  # assigned indirectly by ask_choice
  case "$_store_choice" in
    1) STORE_DRIVER="sqlite" ;;
    2) STORE_DRIVER="memory" ;;
  esac
}

collect_answers() {
  if [ "$ASSUME_YES" = 1 ] && [ -z "${TP_TELEMT_URL:-}" ] && [ -z "$TELEMT_URL_DETECTED" ]; then
    warn "$(t missing_env TP_TELEMT_URL)"
  fi
  ask_telemt_connection
  ask_transport
  ask_listen
  ask_admin
  ask_subpage
  ask_storage
  ask_telemt_paths
  ask_run_as
  validate_transport_rights
  SUBPAGE_SECRET=$(gen_secret)
}

print_summary() {
  if [ -n "$BINARY_FILE" ]; then
    kv "$(t s_version)" "$(t s_local_binary "$BINARY_FILE")"
  else
    kv "$(t s_version)" "${REQ_VERSION:-$(t s_latest)}"
  fi
  kv "$(t s_variant)" "$BUILD_VARIANT"
  kv "$(t s_storage)" "$STORE_DRIVER"
  kv "$(t s_listen)" "$LISTEN"
  kv "$(t s_tls)" "$TLS_MODE${TLS_DOMAIN:+: $TLS_DOMAIN}"
  kv "$(t s_admin)" "$ADMIN_USER"
  kv "$(t s_telemt_url)" "$TELEMT_URL"
  if [ -n "$TELEMT_AUTH" ]; then
    kv "$(t s_auth)" "$(t s_set) ($(mask "$TELEMT_AUTH"))"
  else
    kv "$(t s_auth)" "$(t auth_empty)"
  fi
  kv "$(t s_subpage)" "$(t "$SUBPAGE_ENABLED")"
  kv "$(t d_telemt_bin)" "$TELEMT_BIN"
  kv "$(t d_telemt_svc)" "$TELEMT_SVC"
  if [ "$RUN_AS" = "user" ]; then
    kv "$(t s_run_as)" "$SYSTEM_USER (sudo: $SUDOERS_FILE)"
  else
    kv "$(t s_run_as)" "root"
  fi
  kv "$(t s_service)" "$INIT: $SERVICE_FILE"
  kv "$(t s_paths)" "$PANEL_BIN"
  kv "" "$CONFIG_FILE"
  kv "" "$DATA_DIR"
}

# firewall_ipv6_loopback recognises equivalent spellings of ::1 without trying
# to become a general IPv6 parser. The prefix must be all zero, the final group
# must be one, and compression/group widths must remain structurally valid.
firewall_ipv6_loopback() {
  printf '%s\n' "$1" | awk '
    {
      addr = tolower($0)
      left = substr(addr, 1, 1) == "["
      right = substr(addr, length(addr), 1) == "]"
      if (left != right) exit 1
      if (left) addr = substr(addr, 2, length(addr) - 2)
      sub(/%.*/, "", addr)

      # IPv6 permits a dotted IPv4 tail. Convert that tail to its two hextets
      # so the structural checks below see the same address semantics.
      if (addr ~ /\./) {
        dotted = addr
        sub(/^.*:/, "", dotted)
        if (split(dotted, octets, ".") != 4) exit 1
        for (i = 1; i <= 4; i++) {
          if (octets[i] !~ /^[0-9]+$/ || length(octets[i]) > 3 || octets[i] > 255) exit 1
        }
        prefix = addr
        sub(/[^:]*$/, "", prefix)
        addr = prefix sprintf("%x:%x", octets[1] * 256 + octets[2], octets[3] * 256 + octets[4])
      }

      # IPv4-mapped 127/8 addresses are loopback too. Replace only that exact
      # mapped suffix with zero groups and one, then reuse the ::1 checks.
      if (addr ~ /:ffff:[0-9a-f]+:[0-9a-f]+$/) {
        mapped = addr
        sub(/^.*:ffff:/, "", mapped)
        if (split(mapped, mapped_groups, ":") != 2 ||
            mapped_groups[1] !~ /^7f[0-9a-f][0-9a-f]$/ ||
            mapped_groups[2] !~ /^[0-9a-f]+$/ || length(mapped_groups[2]) > 4) exit 1
        sub(/ffff:[^:]+:[^:]+$/, "0:0:1", addr)
      }

      if (addr !~ /^[0-9a-f:]+$/ || addr !~ /1$/ || index(addr, ":::") != 0) exit 1
      compact = addr
      gsub(/[0:]/, "", compact)
      if (compact != "1") exit 1
      rest = addr
      compressed = gsub(/::/, "", rest)
      if (compressed > 1) exit 1
      rest = addr
      colons = gsub(/:/, "", rest)
      if ((!compressed && colons != 7) || (compressed && (colons < 2 || colons > 7))) exit 1
      count = split(addr, groups, ":")
      for (i = 1; i <= count; i++) {
        if (length(groups[i]) > 4) exit 1
      }
      exit 0
    }'
}

# firewall_ports derives only externally reachable panel ports. ACME also
# needs TCP/80 for HTTP-01; a primary listener already on 80 is not duplicated.
firewall_ports() {
  FIREWALL_PORTS=""
  FIREWALL_PORTS_DISPLAY=""
  host_port_split "$LISTEN" || return 1
  case "$SPLIT_HOST" in
    localhost|127.*) ;;
    *)
      if ! firewall_ipv6_loopback "$SPLIT_HOST"; then
        FIREWALL_PORTS="$SPLIT_PORT"
      fi ;;
  esac
  if [ "$TLS_MODE" = acme ]; then
    case " $FIREWALL_PORTS " in
      *' 80 '*) ;;
      *) FIREWALL_PORTS="${FIREWALL_PORTS:+$FIREWALL_PORTS }80" ;;
    esac
  fi
  for _fw_port in $FIREWALL_PORTS; do
    if [ -z "$FIREWALL_PORTS_DISPLAY" ]; then
      FIREWALL_PORTS_DISPLAY="$_fw_port/tcp"
    else
      FIREWALL_PORTS_DISPLAY="$FIREWALL_PORTS_DISPLAY, $_fw_port/tcp"
    fi
  done
}

firewall_manual() {
  warn "$(t firewall_manual "$FIREWALL_PORTS_DISPLAY")"
}

# detect_firewall selects one already-active supported manager. It never
# installs or enables anything. Return 2 for competing managers and 3 when a
# firewalld ingress zone cannot be chosen without guessing.
detect_firewall() {
  FIREWALL_MANAGER=""
  FIREWALL_ZONE=""
  _fw_ufw=0
  _fw_firewalld=0
  if has ufw; then
    # shellcheck disable=SC2086  # SUDO is either empty or the sudo executable
    _fw_status=$(LC_ALL=C $SUDO ufw status 2>/dev/null || true)
    printf '%s\n' "$_fw_status" | grep -q '^Status: active$' && _fw_ufw=1
  fi
  if has firewall-cmd; then
    # shellcheck disable=SC2086  # SUDO is either empty or the sudo executable
    _fw_state=$(LC_ALL=C $SUDO firewall-cmd --state 2>/dev/null || true)
    [ "$_fw_state" = running ] && _fw_firewalld=1
  fi
  if [ "$_fw_ufw" = 1 ] && [ "$_fw_firewalld" = 1 ]; then
    return 2
  fi
  if [ "$_fw_ufw" = 1 ]; then
    FIREWALL_MANAGER=ufw
    return 0
  fi
  [ "$_fw_firewalld" = 1 ] || return 1

  # Top-level lines are zone names; indented lines contain interface/source
  # bindings. Multiple active zones are ambiguous without route knowledge.
  # shellcheck disable=SC2086  # SUDO is either empty or the sudo executable
  if ! _fw_active=$(LC_ALL=C $SUDO firewall-cmd --get-active-zones 2>/dev/null); then
    return 3
  fi
  _fw_zones=$(printf '%s\n' "$_fw_active" | awk '/^[^[:space:]]/ { print $1 }')
  # shellcheck disable=SC2086  # intentional word splitting counts zone names
  set -- $_fw_zones
  # shellcheck disable=SC2086  # SUDO is either empty or the sudo executable
  if ! _fw_default=$(LC_ALL=C $SUDO firewall-cmd --get-default-zone 2>/dev/null); then
    return 3
  fi
  case "$_fw_default" in
    ''|*[!A-Za-z0-9_-]*) return 3 ;;
  esac
  if [ "$#" -gt 1 ]; then
    return 3
  elif [ "$#" -eq 1 ]; then
    # A different sole active zone may belong only to Docker or a source
    # binding while unassigned internet ingress still uses the default zone.
    [ "$1" = "$_fw_default" ] || return 3
    FIREWALL_ZONE="$1"
  else
    # With no explicit interface/source binding, firewalld uses its default
    # zone for otherwise-unassigned ingress traffic.
    FIREWALL_ZONE="$_fw_default"
  fi
  case "$FIREWALL_ZONE" in
    ''|*[!A-Za-z0-9_-]*) return 3 ;;
  esac
  FIREWALL_MANAGER=firewalld
}

firewall_record_success() {
  if [ -z "$_fw_done" ]; then
    _fw_done="$1"
  else
    _fw_done="$_fw_done, $1"
  fi
}

# configure_firewall is an opt-in installer aid. --yes never grants firewall
# consent: automation must set TP_OPEN_FIREWALL=yes independently.
configure_firewall() {
  case "${TP_OPEN_FIREWALL:-}" in
    yes) _fw_consent=yes ;;
    no) _fw_consent=no ;;
    '') _fw_consent="" ;;
    *) die "$(t firewall_bad_env)" ;;
  esac

  firewall_ports || die "$(t bad_listen)"
  if [ -z "$FIREWALL_PORTS" ]; then
    say "$(t firewall_loopback)"
    return 0
  fi

  _fw_detect=0
  detect_firewall || _fw_detect=$?
  case "$_fw_detect" in
    1)
      warn "$(t firewall_none_active)"
      firewall_manual
      return 0 ;;
    2)
      warn "$(t firewall_manager_ambiguous)"
      firewall_manual
      return 0 ;;
    3)
      warn "$(t firewall_zone_ambiguous)"
      firewall_manual
      return 0 ;;
  esac

  _fw_label="$FIREWALL_MANAGER"
  [ -n "$FIREWALL_ZONE" ] && _fw_label="$FIREWALL_MANAGER ($FIREWALL_ZONE)"
  say "$(t firewall_plan "$_fw_label" "$FIREWALL_PORTS_DISPLAY")"
  if [ -z "$_fw_consent" ]; then
    if [ "$ASSUME_YES" = 1 ] || ! tty_available; then
      _fw_consent=no
    elif confirm_yn no q_firewall; then
      _fw_consent=yes
    else
      _fw_consent=no
    fi
  fi
  if [ "$_fw_consent" != yes ]; then
    firewall_manual
    return 0
  fi

  _fw_failed=0
  _fw_done=""
  for _fw_port in $FIREWALL_PORTS; do
    if [ "$FIREWALL_MANAGER" = ufw ]; then
      if run_try ufw allow "$_fw_port/tcp"; then
        firewall_record_success "$_fw_port/tcp"
      else
        warn "$(t firewall_rule_failed "ufw allow $_fw_port/tcp")"
        _fw_failed=1
      fi
    else
      if run_try firewall-cmd "--zone=$FIREWALL_ZONE" "--add-port=$_fw_port/tcp"; then
        firewall_record_success "$_fw_port/tcp runtime"
      else
        warn "$(t firewall_rule_failed "firewalld $_fw_port/tcp runtime ($FIREWALL_ZONE)")"
        _fw_failed=1
      fi
      if run_try firewall-cmd --permanent "--zone=$FIREWALL_ZONE" "--add-port=$_fw_port/tcp"; then
        firewall_record_success "$_fw_port/tcp permanent"
      else
        warn "$(t firewall_rule_failed "firewalld $_fw_port/tcp permanent ($FIREWALL_ZONE)")"
        _fw_failed=1
      fi
    fi
  done
  if [ "$_fw_failed" = 1 ]; then
    [ -z "$_fw_done" ] || warn "$(t firewall_partial "$_fw_done")"
    firewall_manual
    return 1
  fi
  ok "$(t firewall_success "$_fw_label" "$FIREWALL_PORTS_DISPLAY")"
}

# ═════════════════════════════════════════════════════════════════════════════
#  Apply
# ═════════════════════════════════════════════════════════════════════════════

# user_in_group USER GROUP
user_in_group() {
  id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qx "$2"
}

# add_to_group USER GROUP REASON_KEY
add_to_group() {
  if user_in_group "$1" "$2"; then
    return 0
  fi
  if has usermod; then
    run_try usermod -aG "$2" "$1" || { warn "$(t a_group_fail "$1" "$2" "$2" "$1")"; return 0; }
  else
    run_try adduser "$1" "$2" || { warn "$(t a_group_fail "$1" "$2" "$2" "$1")"; return 0; }
  fi
  ok "$(t a_group "$1" "$2" "$(t "$3")")"
}

create_user() {
  if [ "$RUN_AS" != "user" ]; then
    return 0
  fi
  if id "$SYSTEM_USER" >/dev/null 2>&1; then
    ok "$(t a_user_exists "$SYSTEM_USER")"
  else
    if has useradd; then
      run useradd --system --shell /usr/sbin/nologin --home /nonexistent --no-create-home "$SYSTEM_USER" \
        || die "$(t a_user_fail "$SYSTEM_USER")"
    elif adduser --help 2>&1 | grep -q BusyBox; then
      run adduser -S -D -H -s /sbin/nologin "$SYSTEM_USER" \
        || die "$(t a_user_fail "$SYSTEM_USER")"
    else
      run adduser --system --no-create-home --shell /usr/sbin/nologin --disabled-password "$SYSTEM_USER" \
        || die "$(t a_user_fail "$SYSTEM_USER")"
    fi
    ok "$(t a_user_created "$SYSTEM_USER")"
  fi
  if getent group systemd-journal >/dev/null 2>&1; then
    add_to_group "$SYSTEM_USER" systemd-journal a_group_journal
  fi
  if [ -d /etc/telemt ]; then
    _g=$(stat -c '%G' /etc/telemt 2>/dev/null || true)
    if [ -n "$_g" ] && [ "$_g" != "root" ]; then
      add_to_group "$SYSTEM_USER" "$_g" a_group_telemt
    fi
  fi
}

# Reject broad deletion/chown targets, including existing symlinks to them.
# Custom paths must still be directories dedicated to this installation.
validate_panel_directory() {
  _checked_dir="$1"
  case "$_checked_dir" in
    /*) ;;
    *) die "$(t unsafe_directory "$1")" ;;
  esac
  case "$_checked_dir" in
    */../*|*/..|*/./*|*/.) die "$(t unsafe_directory "$1")" ;;
  esac
  if [ -d "$_checked_dir" ]; then
    if [ -n "$SUDO" ]; then
      _checked_dir=$($SUDO readlink -f "$_checked_dir") || die "$(t unsafe_directory "$1")"
    else
      _checked_dir=$(cd -P "$_checked_dir" && pwd -P) || die "$(t unsafe_directory "$1")"
    fi
  else
    while [ "${_checked_dir%/}" != "$_checked_dir" ]; do _checked_dir=${_checked_dir%/}; done
  fi
  case "$_checked_dir" in
    ''|/|/bin|/sbin|/lib|/lib64|/etc|/usr|/usr/bin|/usr/sbin|/usr/lib|/usr/local|/usr/local/bin|/var|/var/lib|/var/log|/tmp|/var/tmp|/run|/home|/root|/opt|/srv|/mnt|/media|/dev|/proc|/sys)
      die "$(t unsafe_directory "$1")" ;;
    /home/*)
      case "${_checked_dir#/home/}" in */*) ;; *) die "$(t unsafe_directory "$1")" ;; esac ;;
  esac
  if [ -n "${HOME:-}" ] && [ "$_checked_dir" = "$HOME" ]; then
    die "$(t unsafe_directory "$1")"
  fi
}

setup_dirs() {
  validate_panel_directory "$CONFIG_DIR"
  validate_panel_directory "$DATA_DIR"
  _owner="root"
  if [ "$RUN_AS" = "user" ]; then
    _owner="$SYSTEM_USER"
  fi
  _grp=$(owner_group "$_owner")
  run mkdir -p "$BIN_DIR" "$CONFIG_DIR" "$DATA_DIR/staging"
  run chown "$_owner:$_grp" "$CONFIG_DIR" "$DATA_DIR" "$DATA_DIR/staging"
  run chmod 0750 "$CONFIG_DIR" "$DATA_DIR" "$DATA_DIR/staging"
  case "$INIT" in
    openrc|sysvinit)
      run touch "$LOG_FILE"
      run chown "$_owner:$_grp" "$LOG_FILE" ;;
  esac
  ok "$(t a_dirs "$CONFIG_DIR" "$DATA_DIR")"
}

# resolve_tag — sets INSTALLED_TAG from --version or the latest stable release.
resolve_tag() {
  if [ -n "$REQ_VERSION" ]; then
    INSTALLED_TAG="$REQ_VERSION"
    return 0
  fi
  say "$(t a_resolve)"
  _code=$(http_get "https://api.github.com/repos/$REPO/releases/latest")
  [ "$_code" = 200 ] || die "$(t a_resolve_fail)"
  INSTALLED_TAG=$(json_field "$HTTP_BODY" tag_name)
  [ -n "$INSTALLED_TAG" ] || die "$(t a_resolve_fail)"
}

# fetch_release — puts the panel binary at $STAGED_BIN.
release_asset_name() {
  _asset_prefix="$BINARY_NAME"
  if [ "$BUILD_VARIANT" = "lite" ]; then
    _asset_prefix="$BINARY_NAME-lite"
  fi
  printf '%s-%s-linux-%s.tar.gz' "$_asset_prefix" "$ARCH" "$LIBC"
}

fetch_release() {
  ensure_temp_dir
  if [ -n "$BINARY_FILE" ]; then
    [ -f "$BINARY_FILE" ] || die "$(t a_extract_fail "$BINARY_FILE")"
    STAGED_BIN="$TEMP_DIR/$BINARY_NAME"
    cp "$BINARY_FILE" "$STAGED_BIN"
    chmod 0755 "$STAGED_BIN"
    INSTALLED_TAG="local"
    return 0
  fi
  resolve_tag
  _asset=$(release_asset_name)
  _base="https://github.com/$REPO/releases/download/$INSTALLED_TAG"
  _tar="$TEMP_DIR/$_asset"
  say "$(t a_download "$_asset ($INSTALLED_TAG)")"
  download "$_base/$_asset" "$_tar" || die "$(t a_download_fail "$_asset" "$INSTALLED_TAG")"

  _sum="$TEMP_DIR/$_asset.sha256"
  _actual=$(sha256_of "$_tar")
  if [ -z "$_actual" ]; then
    die "$(t no_sha)"
  elif download "$_base/$_asset.sha256" "$_sum" 2>/dev/null; then
    _expected=$(awk '{print $1}' "$_sum" | head -n 1 | tr 'A-F' 'a-f')
    if [ "$_expected" = "$_actual" ]; then
      ok "$(t a_checksum_ok)"
    else
      die "$(t a_checksum_fail)"
    fi
  else
    die "$(t a_checksum_missing)"
  fi

  _entries=$(tar -tzf "$_tar") || die "$(t a_extract_fail "$BINARY_NAME")"
  case "$_entries" in "$BINARY_NAME"|"./$BINARY_NAME") ;; *) die "$(t a_extract_fail "$BINARY_NAME")" ;; esac
  _listing=$(tar -tvzf "$_tar") || die "$(t a_extract_fail "$BINARY_NAME")"
  case "$_listing" in -*) ;; *) die "$(t a_extract_fail "$BINARY_NAME")" ;; esac
  _size=$(printf '%s\n' "$_listing" | awk '{print $3}')
  case "$_size" in ''|*[!0-9]*) die "$(t a_extract_fail "$BINARY_NAME")" ;; esac
  [ "$_size" -le 67108864 ] || die "$(t a_extract_fail "$BINARY_NAME")"
  STAGED_BIN="$TEMP_DIR/$BINARY_NAME"
  tar -xOzf "$_tar" "$_entries" >"$STAGED_BIN" || die "$(t a_extract_fail "$BINARY_NAME")"
  [ -f "$STAGED_BIN" ] || die "$(t a_extract_fail "$BINARY_NAME")"
  chmod 0755 "$STAGED_BIN"
}

install_binary() {
  if [ "$DRY_RUN" = 1 ]; then
    run install -m 0755 "$STAGED_BIN" "$PANEL_BIN"
  else
    UPDATE_STAGED=$($SUDO mktemp "$BIN_DIR/.telemt-panel-new.XXXXXX") || return 1
    $SUDO install -m 0755 "$STAGED_BIN" "$UPDATE_STAGED" || return 1
    if [ "$UPDATE_PENDING" = 1 ] && [ "$UPDATE_COPY_MODE" = --preserve=all ]; then
      $SUDO cp --attributes-only --preserve=all "$UPDATE_BACKUP/binary" "$UPDATE_STAGED" || return 1
      $SUDO chmod 0755 "$UPDATE_STAGED" || return 1
    fi
    $SUDO mv -f "$UPDATE_STAGED" "$PANEL_BIN" || return 1
    UPDATE_STAGED=""
  fi
  ok "$(t a_installed_bin "$PANEL_BIN" "$INSTALLED_TAG")"
}

# hash_password — bcrypt via the staged binary (works before it is installed).
hash_password() {
  PASS_HASH=$(printf '%s\n' "$ADMIN_PASS" | "$STAGED_BIN" hash-password 2>/dev/null) || PASS_HASH=""
  if [ -z "$PASS_HASH" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      # shellcheck disable=SC2016
      PASS_HASH='$2a$10$DRY-RUN-PLACEHOLDER'
    else
      die "$(t a_hash_fail)"
    fi
  fi
}

write_config() {
  _owner="root"
  if [ "$RUN_AS" = "user" ]; then
    _owner="$SYSTEM_USER"
  fi
  gen_config | write_root_file "$CONFIG_FILE" 0600 "$_owner"
  ok "$(t a_config_written "$CONFIG_FILE")"
}

install_sudoers() {
  if [ "$RUN_AS" != "user" ]; then
    if [ -f "$SUDOERS_FILE" ]; then
      run rm -f "$SUDOERS_FILE"
      ok "$(t a_sudoers_removed)"
    fi
    return 0
  fi
  ensure_temp_dir
  _tmp="$TEMP_DIR/sudoers"
  gen_sudoers >"$_tmp"
  if has visudo && [ "$DRY_RUN" != 1 ]; then
    $SUDO visudo -cf "$_tmp" >/dev/null || die "$(t a_sudoers_invalid)"
  fi
  run mkdir -p "$(dirname "$SUDOERS_FILE")"
  write_root_file "$SUDOERS_FILE" 0440 <"$_tmp"
  ok "$(t a_sudoers "$SUDOERS_FILE")"
}

install_service() {
  case "$INIT" in
    systemd)
      gen_service | write_root_file "$SERVICE_FILE" 0644
      run systemctl daemon-reload
      run_try systemctl enable "$SERVICE_NAME" ;;
    openrc)
      gen_service | write_root_file "$SERVICE_FILE" 0755
      run_quiet rc-update add "$SERVICE_NAME" default ;;
    procd)
      gen_service | write_root_file "$SERVICE_FILE" 0755
      run "$SERVICE_FILE" enable ;;
    sysvinit)
      gen_service | write_root_file "$SERVICE_FILE" 0755
      if has update-rc.d; then
        run_try update-rc.d "$SERVICE_NAME" defaults
      elif has chkconfig; then
        run_try chkconfig --add "$SERVICE_NAME"
      else
        warn "$(t a_service_manual "$SERVICE_NAME")"
      fi ;;
  esac
  ok "$(t a_service "$SERVICE_NAME" "$SERVICE_FILE")"
}

start_service() {
  if [ "$NO_START" = 1 ]; then
    warn "$(t a_not_started "$(cmd_restart)")"
    return 0
  fi
  _cmd=$(cmd_restart)
  # shellcheck disable=SC2086
  run $_cmd
  ok "$(t a_started)"
  if [ "$DRY_RUN" = 1 ]; then
    return 0
  fi
  if [ "$TLS_MODE" != http ]; then
    if ! $SUDO "$PANEL_BIN" tls check --config "$CONFIG_FILE" --timeout 120s; then
      warn "$(t tls_check_failed "$(cmd_logs)")"
      return 1
    fi
    ok "$(t a_health_ok HTTPS)"
    return 0
  fi
  _url=$(health_url "$LISTEN") || return 0
  _i=0
  while [ "$_i" -lt "$HEALTH_WAIT_SECONDS" ]; do
    if [ "$(http_get "$_url")" = 200 ]; then
      ok "$(t a_health_ok "$_url")"
      return 0
    fi
    sleep 1
    _i=$((_i + 1))
  done
  warn "$(t a_health_fail "$HEALTH_WAIT_SECONDS" "$(cmd_logs)")"
  return 1
}

print_done() {
  host_port_split "$LISTEN" || return 0
  say "$(t done_open)"
  if [ "$TLS_MODE" = acme ]; then
    printf '    %shttps://%s:%s%s\n' "$C_CYAN" "$TLS_DOMAIN" "$SPLIT_PORT" "$C_RESET"
  elif [ "$TLS_MODE" = certificate ]; then
    printf '    %shttps://<certificate-domain>:%s%s\n' "$C_CYAN" "$SPLIT_PORT" "$C_RESET"
  else
   case "$SPLIT_HOST" in
    ''|0.0.0.0|'[::]'|'::')
      _any=0
      for _ip in $(host_addresses); do
        printf '    %shttp://%s:%s%s\n' "$C_CYAN" "$_ip" "$SPLIT_PORT" "$C_RESET"
        _any=1
      done
      [ "$_any" = 1 ] || printf '    %shttp://<server-ip>:%s%s\n' "$C_CYAN" "$SPLIT_PORT" "$C_RESET" ;;
    *) printf '    %shttp://%s%s\n' "$C_CYAN" "$LISTEN" "$C_RESET" ;;
  esac
  fi
  say "  $(t done_login "$ADMIN_USER")"
  blank
  say "$(t done_commands)"
  kv "  $(t done_status)" "$(cmd_status)"
  kv "  $(t done_restart)" "$(cmd_restart)"
  kv "  $(t done_logs)" "$(cmd_logs)"
  blank
  say "$(t done_edit "$CONFIG_FILE")"
  say "$(t done_update)"
  say "$(t done_uninstall)"
  if [ "$INIT" = "procd" ]; then
    blank
    warn "$(t a_sysupgrade "$CONFIG_DIR")"
  fi
  blank
}

# ═════════════════════════════════════════════════════════════════════════════
#  Existing installation: update (1.x) and migration (0.x)
# ═════════════════════════════════════════════════════════════════════════════


# validate_existing_store_variant refuses a profile switch that would leave the
# preserved configuration unreadable by the newly installed binary. It runs
# after staged inspection, before any installation files or services are changed.
validate_existing_store_variant() {
  if [ "$BUILD_VARIANT" = "lite" ] && [ "$STORE_DRIVER" != "memory" ]; then
    die "$(t store_lite_existing "$STORE_DRIVER")"
  fi
}


# apply_layout_from_answers — PANEL_BIN may have come from an old config;
# keep BIN_DIR and SERVICE_FILE consistent with it.
apply_layout_from_answers() {
  validate_service_names
  BIN_DIR=$(dirname "$PANEL_BIN")
  case "$INIT" in
    systemd) SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service" ;;
    *) SERVICE_FILE="/etc/init.d/$SERVICE_NAME" ;;
  esac
}

# Existing installations retain config/unit/sudoers; only the binary changes.
# The staged Go parser is authoritative, including legacy TOML.
staged_inspect() {
  # Unknown commands in 0.6 start its daemon. An empty working directory keeps
  # an accidentally selected old candidate from finding a caller's config.toml.
  (cd "$UPDATE_PROBE_DIR" && timeout 15 "$STAGED_BIN" "$@")
}

do_update_existing() {
  step 3 step_update
  if ! has timeout || ! has sha256sum || ! has readlink; then die "$(t update_preflight_failed)"; fi
  ensure_temp_dir
  UPDATE_SOURCE="$TEMP_DIR/existing.toml"
  # Snapshot once with privileges; never treat unreadable config as defaults.
  $SUDO test -f "$CONFIG_FILE" || die "$(t update_preflight_failed)"
  $SUDO cat "$CONFIG_FILE" >"$UPDATE_SOURCE" || die "$(t update_preflight_failed)"
  chmod 0600 "$UPDATE_SOURCE"
  fetch_release
  UPDATE_PROBE_DIR="$TEMP_DIR/probe"
  mkdir "$UPDATE_PROBE_DIR" || die "$(t update_preflight_failed)"
  UPDATE_VERSION=$(staged_inspect version) || die "$(t update_preflight_failed)"
  if [ -n "$BINARY_FILE" ] && [ "$VARIANT_EXPLICIT" = 0 ]; then
    case "$UPDATE_VERSION" in
      "telemt-panel "*" (full:"*) BUILD_VARIANT=full ;;
      "telemt-panel "*" (lite:"*) BUILD_VARIANT=lite ;;
    esac
  fi
  case "$UPDATE_VERSION" in "telemt-panel "*" ($BUILD_VARIANT:"*) ;; *) die "$(t update_preflight_failed)" ;; esac
  staged_inspect config inspect --config "$UPDATE_SOURCE" >"$TEMP_DIR/inspect.json" || die "$(t update_preflight_failed)"
  PANEL_BIN=$(json_field "$TEMP_DIR/inspect.json" panel_binary_path)
  SERVICE_NAME=$(json_field "$TEMP_DIR/inspect.json" panel_service)
  STORE_DRIVER=$(json_field "$TEMP_DIR/inspect.json" store_driver)
  LISTEN=$(json_field "$TEMP_DIR/inspect.json" listen)
  TLS_MODE=$(json_field "$TEMP_DIR/inspect.json" tls_mode)
  sudoers_path_ok "$PANEL_BIN" || die "$(t update_preflight_failed)"
  validate_existing_store_variant
  apply_layout_from_answers
  if [ ! -f "$PANEL_BIN" ] || [ -L "$PANEL_BIN" ] || [ ! -f "$SERVICE_FILE" ]; then die "$(t update_preflight_failed)"; fi
  if ! $SUDO grep -qF "$PANEL_BIN" "$SERVICE_FILE" || ! $SUDO grep -qF "$CONFIG_FILE" "$SERVICE_FILE"; then die "$(t update_preflight_failed)"; fi
  [ "$(readlink -f "$PANEL_BIN")" = "$PANEL_BIN" ] || die "$(t update_preflight_failed)"
  if [ "$INSTALLED_TAG" != local ]; then
    UPDATE_CANDIDATE_VERSION=$(printf '%s\n' "$UPDATE_VERSION" | awk '{print $2}')
    [ "${UPDATE_CANDIDATE_VERSION#v}" = "${INSTALLED_TAG#v}" ] || die "$(t update_preflight_failed)"
  fi
  UPDATE_CONFIG_HASH=$($SUDO sha256sum "$CONFIG_FILE" | awk '{print $1}')
  [ "$UPDATE_CONFIG_HASH" = "$(sha256_of "$UPDATE_SOURCE")" ] || die "$(t update_preflight_failed)"
  blank
  say "$(t update_preserve)"
  kv "$(t s_version)" "$UPDATE_VERSION"
  kv "$(t s_service)" "$SERVICE_FILE"
  if grep -q '"requires_migration": true' "$TEMP_DIR/inspect.json"; then
    warn "$(t update_legacy)"
  fi
  if grep -q 'telemt_config_api_required' "$TEMP_DIR/inspect.json"; then warn "$(t migrate_config_api_only)"; fi
  if grep -Eq '"(user_defaults|release_limits)_not_applied"' "$TEMP_DIR/inspect.json"; then warn "$(t migrate_archived_settings)"; fi
  confirm continue_q || { say "$(t aborted)"; exit 0; }
  if [ "$DRY_RUN" = 1 ]; then
    say "$(t update_dry)"
    return 0
  fi
  if [ "$NO_START" != 1 ]; then
    UPDATE_FINGERPRINT=$($SUDO "$STAGED_BIN" tls fingerprint --config "$UPDATE_SOURCE" --timeout 15s) || die "$(t update_preflight_failed)"
  fi
  [ "$($SUDO sha256sum "$CONFIG_FILE" | awk '{print $1}')" = "$UPDATE_CONFIG_HASH" ] || die "$(t update_preflight_failed)"
  UPDATE_BACKUP=$($SUDO mktemp -d "$BIN_DIR/.telemt-panel-backup.XXXXXX") || die "$(t update_preflight_failed)"
  if cp --help 2>&1 | grep -q -- '--attributes-only'; then UPDATE_COPY_MODE=--preserve=all; fi
  $SUDO cp "$UPDATE_COPY_MODE" "$PANEL_BIN" "$UPDATE_BACKUP/binary" || die "$(t update_preflight_failed)"
  UPDATE_BINARY_HASH=$($SUDO sha256sum "$PANEL_BIN" | awk '{print $1}')
  [ "${#UPDATE_BINARY_HASH}" = 64 ] || die "$(t update_preflight_failed)"
  [ "$($SUDO sha256sum "$UPDATE_BACKUP/binary" | awk '{print $1}')" = "$UPDATE_BINARY_HASH" ] || die "$(t update_preflight_failed)"
  say "$(t update_backup "$UPDATE_BACKUP")"
  UPDATE_PENDING=1
  if [ "$NO_START" != 1 ]; then
    case "$INIT" in
      systemd) run systemctl stop "$SERVICE_NAME" || die "$(t update_apply_failed)" ;;
      openrc) run rc-service "$SERVICE_NAME" stop || die "$(t update_apply_failed)" ;;
      *) run "$SERVICE_FILE" stop || die "$(t update_apply_failed)" ;;
    esac
  fi
  install_binary || die "$(t update_apply_failed)"
  if [ "$NO_START" = 1 ]; then
    UPDATE_PENDING=0
    warn "$(t a_not_started "$(cmd_restart)")"
    return 0
  fi
  # Retained service definition: do not enable, regenerate or change its user.
  _restart=$(cmd_restart)
  # shellcheck disable=SC2086
  run $_restart || die "$(t update_apply_failed)"
  $SUDO "$STAGED_BIN" tls check --config "$UPDATE_SOURCE" --timeout 120s || die "$(t update_apply_failed)"
  if [ "$INIT" = systemd ]; then run_try systemctl is-active --quiet "$SERVICE_NAME" || die "$(t update_apply_failed)"; fi
  UPDATE_PENDING=0
  ok "$(t update_verified)"
}

restore_update() {
  warn "$(t update_restoring)"
  UPDATE_PENDING=0
  if [ -n "$UPDATE_STAGED" ]; then $SUDO rm -f "$UPDATE_STAGED" || true; UPDATE_STAGED=""; fi
  # A failed copy/rename may leave the old binary intact (including on ENOSPC).
  # Restart it without demanding enough free space for another complete copy.
  if [ "$($SUDO sha256sum "$PANEL_BIN" 2>/dev/null | awk '{print $1}')" != "$UPDATE_BINARY_HASH" ]; then
    UPDATE_RESTORE=$($SUDO mktemp "$BIN_DIR/.telemt-panel-restore.XXXXXX") || return 1
    $SUDO cp "$UPDATE_COPY_MODE" "$UPDATE_BACKUP/binary" "$UPDATE_RESTORE" || return 1
    [ "$($SUDO sha256sum "$UPDATE_RESTORE" | awk '{print $1}')" = "$UPDATE_BINARY_HASH" ] || return 1
    $SUDO mv -f "$UPDATE_RESTORE" "$PANEL_BIN" || return 1
    UPDATE_RESTORE=""
  fi
  if [ "$NO_START" = 1 ]; then return 0; fi
  if [ "$INIT" = systemd ]; then $SUDO systemctl reset-failed "$SERVICE_NAME" || return 1; fi
  _restart=$(cmd_restart)
  # shellcheck disable=SC2086
  $SUDO $_restart || return 1
  $SUDO "$STAGED_BIN" tls check --config "$UPDATE_SOURCE" --expect-fingerprint "$UPDATE_FINGERPRINT" --timeout 45s || return 1
  if [ "$INIT" = systemd ]; then $SUDO systemctl is-active --quiet "$SERVICE_NAME" || return 1; fi
  warn "$(t update_restored "$UPDATE_BACKUP")"
}

# ═════════════════════════════════════════════════════════════════════════════
#  Scenarios
# ═════════════════════════════════════════════════════════════════════════════

do_install() {
  require_tty
  blank
  printf '%s%s%s\n' "$C_BOLD" "$(t welcome_title)" "$C_RESET"
  blank
  tl welcome_body
  if [ "$DRY_RUN" = 1 ]; then
    blank
    warn "$(t dry_run_banner)"
  fi
  blank
  confirm continue_q || { say "$(t aborted)"; exit 0; }

  step 1 step_prereq
  check_prereqs

  step 2 step_detect
  detect_all
  print_detection
  if [ "$INIT" = "none" ]; then
    die "$(t no_init "$PANEL_BIN" "$CONFIG_FILE")"
  fi
  blank
  print_telemt_detection
  if [ -z "$TELEMT_BIN_DETECTED" ] && [ -z "$TELEMT_URL_DETECTED" ]; then
    blank
    warn "$(t telemt_missing)"
  fi

  case "$EXISTING" in
    present) do_update_existing; return 0 ;;
  esac

  step 3 step_questions
  collect_answers
  apply_layout_from_answers

  step 4 step_summary
  print_summary
  blank
  confirm apply_q || { say "$(t aborted)"; exit 0; }

  step 5 step_apply
  fetch_release
  create_user
  setup_dirs
  hash_password
  install_binary
  write_config
  install_sudoers
  install_service
  configure_firewall
  start_service

  step 6 step_done
  print_done
}

# Parse once before any stop/delete; reuse the existing bounded Go CLI.
prepare_removal() {
  require_tty
  check_prereqs_quiet
  detect_init
  apply_layout
  ensure_temp_dir
  if ! $SUDO test -f "$CONFIG_FILE"; then
    if [ "$CMD" = uninstall ] && [ ! -e "$PANEL_BIN" ] && [ ! -e "$SERVICE_FILE" ] && [ ! -e "$SUDOERS_FILE" ]; then say "$(t u_nothing)"; exit 0; fi
    die "$(t remove_parser)"
  fi
  if ! has timeout || ! has sha256sum || ! has readlink; then die "$(t remove_parser)"; fi
  UPDATE_SOURCE="$TEMP_DIR/removal.toml"
  $SUDO cat "$CONFIG_FILE" >"$UPDATE_SOURCE" || die "$(t remove_unsafe)"
  chmod 0600 "$UPDATE_SOURCE"
  REMOVE_CONFIG_HASH=$(sha256_of "$UPDATE_SOURCE")
  REMOVE_PARSER="${BINARY_FILE:-$PANEL_BIN}"
  [ -f "$REMOVE_PARSER" ] || die "$(t remove_parser)"
  STAGED_BIN="$TEMP_DIR/$BINARY_NAME"
  $SUDO install -m 0755 "$REMOVE_PARSER" "$STAGED_BIN" || die "$(t remove_parser)"
  UPDATE_PROBE_DIR="$TEMP_DIR/probe"
  mkdir "$UPDATE_PROBE_DIR"
  staged_inspect config inspect --config "$UPDATE_SOURCE" >"$TEMP_DIR/removal.json" || die "$(t remove_parser)"
  PANEL_BIN=$(json_field "$TEMP_DIR/removal.json" panel_binary_path)
  TELEMT_BIN=$(json_field "$TEMP_DIR/removal.json" telemt_binary_path)
  SERVICE_NAME=$(json_field "$TEMP_DIR/removal.json" panel_service)
  TELEMT_SVC=$(json_field "$TEMP_DIR/removal.json" telemt_service)
  DATA_DIR=$(json_field "$TEMP_DIR/removal.json" data_dir)
  sudoers_path_ok "$PANEL_BIN" || die "$(t remove_unsafe)"
  sudoers_path_ok "$TELEMT_BIN" || die "$(t remove_unsafe)"
  apply_layout_from_answers
  [ "$SERVICE_NAME" != "$TELEMT_SVC" ] || die "$(t remove_unsafe)"
  [ "$($SUDO readlink -f "$PANEL_BIN")" != "$($SUDO readlink -f "$TELEMT_BIN")" ] || die "$(t remove_unsafe)"
  for REMOVE_PROTECTED_FILE in "$CONFIG_FILE" "$TELEMT_CONFIG" "$SERVICE_FILE" "$SUDOERS_FILE"; do
    [ "$($SUDO readlink -f "$PANEL_BIN")" != "$($SUDO readlink -f "$REMOVE_PROTECTED_FILE")" ] || die "$(t remove_unsafe)"
  done
  for REMOVE_FILE in "$PANEL_BIN" "$SERVICE_FILE" "$SUDOERS_FILE"; do
    [ ! -L "$REMOVE_FILE" ] || die "$(t remove_unsafe)"
    if [ -e "$REMOVE_FILE" ] && [ ! -f "$REMOVE_FILE" ]; then die "$(t remove_unsafe)"; fi
  done
  if [ -f "$SERVICE_FILE" ]; then
    if ! $SUDO grep -qF "$PANEL_BIN" "$SERVICE_FILE" || ! $SUDO grep -qF "$CONFIG_FILE" "$SERVICE_FILE"; then die "$(t remove_unsafe)"; fi
  elif [ -f "$PANEL_BIN" ]; then
    # Without a matching service definition, do not unlink a possibly running daemon.
    die "$(t remove_unsafe)"
  fi
  validate_removal_data
  say "$(t remove_targets)"
  kv "$(t s_service)" "$SERVICE_FILE"
  kv "$(t s_paths)" "$PANEL_BIN"
  kv "sudoers" "$SUDOERS_FILE"
}

validate_removal_data() {
  if [ "$CMD" != purge ]; then return 0; fi
  validate_panel_directory "$CONFIG_DIR"
  sudoers_path_ok "$CONFIG_DIR" || die "$(t remove_unsafe)"
  if [ -n "$DATA_DIR" ]; then
    validate_panel_directory "$DATA_DIR"
    sudoers_path_ok "$DATA_DIR" || die "$(t remove_unsafe)"
  fi
  for REMOVE_DIR in "$CONFIG_DIR" "${DATA_DIR:-$CONFIG_DIR}"; do
    [ ! -L "$REMOVE_DIR" ] || die "$(t remove_unsafe)"
    REMOVE_CANON=$($SUDO readlink -f "$REMOVE_DIR") || die "$(t remove_unsafe)"
    for REMOVE_PROTECTED in "$TELEMT_BIN" "$TELEMT_CONFIG" "$BIN_DIR" "$(dirname "$SERVICE_FILE")" "$(dirname "$SUDOERS_FILE")"; do
      REMOVE_PROTECTED=$($SUDO readlink -f "$REMOVE_PROTECTED") || die "$(t remove_unsafe)"
      case "$REMOVE_PROTECTED" in "$REMOVE_CANON"|"$REMOVE_CANON"/*) die "$(t remove_unsafe)" ;; esac
    done
  done
}

stop_and_disable_service() {
  case "$INIT" in
    systemd)
      run systemctl stop "$SERVICE_NAME" || return 1
      run systemctl disable "$SERVICE_NAME" || return 1 ;;
    openrc)
      run rc-service "$SERVICE_NAME" stop || return 1
      run rc-update del "$SERVICE_NAME" default || return 1 ;;
    procd)
      run "$SERVICE_FILE" stop || return 1
      run "$SERVICE_FILE" disable || return 1 ;;
    sysvinit)
      run "$SERVICE_FILE" stop || return 1
      if has update-rc.d; then run update-rc.d -f "$SERVICE_NAME" remove || return 1
      elif has chkconfig; then run chkconfig --del "$SERVICE_NAME" || return 1; fi ;;
    *) return 1 ;;
  esac
}

remove_panel_files() {
  [ "$($SUDO sha256sum "$CONFIG_FILE" | awk '{print $1}')" = "$REMOVE_CONFIG_HASH" ] || die "$(t remove_unsafe)"
  if [ -f "$SERVICE_FILE" ]; then
    stop_and_disable_service || die "$(t remove_failed)"
    run rm -f "$SERVICE_FILE" || die "$(t remove_failed)"
    if [ "$INIT" = systemd ]; then run systemctl daemon-reload || die "$(t remove_failed)"; fi
  fi
  run rm -f "$PANEL_BIN" || die "$(t remove_failed)"
  run rm -f "$SUDOERS_FILE" || die "$(t remove_failed)"
}

do_uninstall() {
  prepare_removal
  confirm_danger uninstall_q || { say "$(t aborted)"; exit 0; }
  remove_panel_files
  say "$(t u_kept "$CONFIG_DIR" "$DATA_DIR")"
}

do_purge() {
  prepare_removal
  confirm_danger purge_q "$CONFIG_DIR" "$DATA_DIR" "$SYSTEM_USER" || { say "$(t aborted)"; exit 0; }
  remove_panel_files
  validate_removal_data
  [ "$($SUDO sha256sum "$CONFIG_FILE" | awk '{print $1}')" = "$REMOVE_CONFIG_HASH" ] || die "$(t remove_unsafe)"
  run rm -rf "$CONFIG_DIR" || die "$(t remove_failed)"
  if [ -n "$DATA_DIR" ] && [ "$DATA_DIR" != "$CONFIG_DIR" ]; then run rm -rf "$DATA_DIR" || die "$(t remove_failed)"; fi
  # Do not remove an OS account or an external logfile based on a guessed name.
  ok "$(t u_purged)"
}

# check_prereqs_quiet — root/sudo only (uninstall needs nothing else).
check_prereqs_quiet() {
  if [ "$(id -u)" -ne 0 ]; then
    has sudo || die "$(t need_root)"
    SUDO="sudo"
    if [ "$DRY_RUN" != 1 ]; then
      sudo -v || die "$(t need_root)"
    fi
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  Main
# ═════════════════════════════════════════════════════════════════════════════

usage() {
  t help "$PANEL_BIN" "$CONFIG_FILE" "$DATA_DIR"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --lang) shift; L="${1:-}" ;;
      --lang=*) L="${1#--lang=}" ;;
      --version) shift; REQ_VERSION="${1:-}" ;;
      --version=*) REQ_VERSION="${1#--version=}" ;;
      --binary) shift; BINARY_FILE="${1:-}" ;;
      --binary=*) BINARY_FILE="${1#--binary=}" ;;
      --variant) shift; BUILD_VARIANT="${1:-}" ;;
      --variant=*) BUILD_VARIANT="${1#--variant=}" ;;
      --yes|-y) ASSUME_YES=1 ;;
      --no-start) NO_START=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --no-color) COLOR=0 ;;
      -h|--help|help) CMD="help" ;;
      install|uninstall|purge) CMD="$1" ;;
      *) die "$(t unknown_option "$1")" ;;
    esac
    shift
  done
}

choose_language() {
  _l="${L:-${TP_LANG:-}}"
  case "$_l" in
    ''|ru|en) ;;
    *) L=""; die "$(t unknown_option "--lang $_l")" ;;
  esac
  if [ -z "$_l" ]; then
    _def=2
    case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
      ru*|RU*) _def=1 ;;
    esac
    if [ "$ASSUME_YES" = 1 ] || ! tty_available; then
      _l=$([ "$_def" = 1 ] && printf 'ru' || printf 'en')
    else
      while :; do
        printf '%s [%s]: ' "$(t lang_prompt)" "$_def"
        read_tty _v
        [ -z "$_v" ] && _v="$_def"
        case "$_v" in
          1) _l="ru"; break ;;
          2) _l="en"; break ;;
        esac
      done
    fi
  fi
  L="$_l"
}

main() {
  L=""
  parse_args "$@"
  setup_colors
  ensure_temp_dir
  if [ "$CMD" = "help" ]; then
    [ -n "$L" ] || L="${TP_LANG:-en}"
    case "$L" in ru|en) ;; *) L="en" ;; esac
    usage
    exit 0
  fi
  choose_language
  case "$CMD" in
    install) do_install ;;
    uninstall) do_uninstall ;;
    purge) do_purge ;;
  esac
}

# Sourcing guard for tests: `TP_SOURCED=1 . ./install.sh` loads the functions
# without running anything.
if [ "${TP_SOURCED:-}" = 1 ]; then
  # shellcheck disable=SC2317
  return 0 2>/dev/null || exit 0
fi

main "$@"
