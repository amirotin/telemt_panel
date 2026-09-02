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
# Design notes: every host mutation goes through run()/write_root_file(), so
# --dry-run can show the complete plan without touching anything; every
# user-facing string lives in t() so both languages stay in one place.
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
ADMIN_USER="admin"
ADMIN_PASS=""
PASS_HASH=""
SUBPAGE_ENABLED="yes"
SUBPAGE_SECRET=""
TELEMT_BIN=""
TELEMT_SVC="telemt"
RUN_AS="user"
INSTALLED_TAG=""

SUDO=""
TEMP_DIR=""
HTTP_BODY=""
NL='
'

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
  purge          удалить всё, включая конфиг, данные и пользователя
  help           эта справка

Параметры:
  --lang ru|en     язык (иначе спросим; подсказка из $LANG)
  --version vX.Y.Z конкретный релиз (иначе последний стабильный)
  --binary FILE    поставить готовый бинарь вместо скачивания
  --yes            без вопросов: значения из переменных TP_* или умолчания
  --no-start       установить, но не запускать сервис
  --dry-run        показать, что будет сделано, ничего не меняя
  --no-color       без цветов

Переменные для --yes (в интерактиве задают умолчания):
  TP_LANG, TP_TELEMT_URL, TP_TELEMT_AUTH_HEADER, TP_ADMIN_USER,
  TP_ADMIN_PASSWORD (обязательна), TP_LISTEN, TP_TELEMT_BINARY,
  TP_TELEMT_SERVICE, TP_SUBPAGE=yes|no, TP_RUN_AS=user|root, TP_DATA_DIR

Пути: бинарь %s, конфиг %s, данные %s
' ;;
    en:help) _f='Telemt Panel 1.x installer

Usage: sh install.sh [options] [command]

Commands:
  install        install, update, or migrate from 0.x (default)
  uninstall      remove binary, service and sudoers; keep config and data
  purge          remove everything including config, data and the user
  help           this help

Options:
  --lang ru|en     language (otherwise asked; hint taken from $LANG)
  --version vX.Y.Z install a specific release (default: latest stable)
  --binary FILE    install a local binary instead of downloading
  --yes            no questions: values from TP_* variables or defaults
  --no-start       install everything but do not start the service
  --dry-run        show what would be done without changing anything
  --no-color       disable colours

Variables for --yes (they pre-fill defaults in interactive mode):
  TP_LANG, TP_TELEMT_URL, TP_TELEMT_AUTH_HEADER, TP_ADMIN_USER,
  TP_ADMIN_PASSWORD (required), TP_LISTEN, TP_TELEMT_BINARY,
  TP_TELEMT_SERVICE, TP_SUBPAGE=yes|no, TP_RUN_AS=user|root, TP_DATA_DIR

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
    ru:step_telemt) _f='Поиск Telemt' ;;
    en:step_telemt) _f='Locating Telemt' ;;
    ru:step_questions) _f='Настройка' ;;
    en:step_questions) _f='Configuration' ;;
    ru:step_summary) _f='Сводка' ;;
    en:step_summary) _f='Summary' ;;
    ru:step_apply) _f='Установка' ;;
    en:step_apply) _f='Installing' ;;
    ru:step_done) _f='Готово' ;;
    en:step_done) _f='Done' ;;
    ru:step_migrate) _f='Миграция с 0.x' ;;
    en:step_migrate) _f='Migrating from 0.x' ;;
    ru:step_update) _f='Обновление установленной панели' ;;
    en:step_update) _f='Updating the installed panel' ;;

    # ── prerequisites ──
    ru:need_root) _f='Нужны права root: запустите от root или пользователя с sudo.' ;;
    en:need_root) _f='Root privileges are required: run as root or as a user with sudo.' ;;
    ru:sudo_check) _f='Проверяю sudo (может спросить пароль вашего пользователя)…' ;;
    en:sudo_check) _f='Checking sudo (it may ask for your user password)…' ;;
    ru:missing_cmd) _f='Не найдена команда «%s». Установите: %s' ;;
    en:missing_cmd) _f='Command "%s" not found. Install it: %s' ;;
    ru:no_sha) _f='Нет sha256sum — контрольная сумма скачанного файла проверяться не будет.' ;;
    en:no_sha) _f='sha256sum not found — the downloaded file checksum will not be verified.' ;;
    ru:prereq_ok) _f='curl/wget, tar и права есть' ;;
    en:prereq_ok) _f='curl/wget, tar and privileges are available' ;;

    # ── detection ──
    ru:unsupported_arch) _f='Архитектура %s не поддерживается (нужна x86_64, aarch64, armv7, mipsle или mips).' ;;
    en:unsupported_arch) _f='Architecture %s is not supported (need x86_64, aarch64, armv7, mipsle or mips).' ;;
    ru:no_init) _f='Не удалось распознать систему инициализации (нет systemd, OpenRC, procd, sysvinit).\nПанель можно запустить вручную: %s --config %s' ;;
    en:no_init) _f='Could not recognise the init system (no systemd, OpenRC, procd or sysvinit).\nThe panel can still be started by hand: %s --config %s' ;;
    ru:d_arch) _f='Архитектура' ;;
    en:d_arch) _f='Architecture' ;;
    ru:d_libc) _f='Библиотека C' ;;
    en:d_libc) _f='C library' ;;
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
    ru:d_existing_v1) _f='установлена 1.x (конфиг %s)' ;;
    en:d_existing_v1) _f='1.x installed (config %s)' ;;
    ru:d_existing_v0) _f='установлена 0.x (конфиг %s)' ;;
    en:d_existing_v0) _f='0.x installed (config %s)' ;;
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

    # ── summary ──
    ru:s_version) _f='Версия панели' ;;
    en:s_version) _f='Panel version' ;;
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
    ru:a_checksum_missing) _f='Файл контрольной суммы не опубликован — проверка пропущена.' ;;
    en:a_checksum_missing) _f='No checksum file published — verification skipped.' ;;
    ru:a_extract_fail) _f='В архиве нет файла %s.' ;;
    en:a_extract_fail) _f='The archive does not contain %s.' ;;
    ru:a_installed_bin) _f='Установлен %s (%s)' ;;
    en:a_installed_bin) _f='Installed %s (%s)' ;;
    ru:a_hash_fail) _f='Не удалось вычислить хеш пароля (бинарь не запускается на этой системе?).' ;;
    en:a_hash_fail) _f='Could not hash the password (does the binary run on this system?).' ;;
    ru:a_config_written) _f='Конфиг записан: %s' ;;
    en:a_config_written) _f='Config written: %s' ;;
    ru:a_config_kept) _f='Конфиг сохранён без изменений: %s' ;;
    en:a_config_kept) _f='Config kept unchanged: %s' ;;
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
    ru:update_intro) _f='Панель 1.x уже установлена. Будут обновлены бинарь, политика sudo и файл сервиса;\nконфиг %s останется как есть.' ;;
    en:update_intro) _f='Panel 1.x is already installed. The binary, sudo policy and service file will be\nrefreshed; the config %s stays as it is.' ;;
    ru:migrate_intro) _f='Найдена панель 0.x (конфиг %s). Формат конфига в 1.x изменился:\nсессии больше не используют jwt_secret, появились страница подписки и явные настройки\nхоста. Скрипт перенесёт значения в новый формат, а старый файл сохранит рядом.' ;;
    en:migrate_intro) _f='A 0.x panel was found (config %s). The 1.x config format changed: sessions no\nlonger use jwt_secret, and the subscription page and explicit host settings were\nadded. The script converts the values and keeps the old file next to the new one.' ;;
    ru:migrate_q) _f='1) Мигрировать (рекомендуется)  2) Отменить' ;;
    en:migrate_q) _f='1) Migrate (recommended)  2) Cancel' ;;
    ru:migrate_backup) _f='Старый конфиг сохранён: %s' ;;
    en:migrate_backup) _f='Old config saved as: %s' ;;
    ru:migrate_skipped_title) _f='Не перенесено (нет аналога в 1.x, значения остались в резервной копии):' ;;
    en:migrate_skipped_title) _f='Not migrated (no 1.x equivalent, values remain in the backup):' ;;
    ru:mk_jwt) _f='сессии хранятся в store панели, ключ не нужен' ;;
    en:mk_jwt) _f='sessions live in the panel store, the key is no longer needed' ;;
    ru:mk_auto_update) _f='автообновление настраивается в панели (Сервер → Обновления)' ;;
    en:mk_auto_update) _f='auto-update is configured in the panel (Server → Updates)' ;;
    ru:mk_tls) _f='встроенный TLS/ACME вернётся в следующей волне 1.x' ;;
    en:mk_tls) _f='built-in TLS/ACME returns in a later 1.x wave' ;;
    ru:mk_geoip) _f='GeoIP вернётся в следующей волне 1.x' ;;
    en:mk_geoip) _f='GeoIP returns in a later 1.x wave' ;;
    ru:mk_users) _f='шаблоны пользователей в 1.x не используются' ;;
    en:mk_users) _f='user templates are not used in 1.x' ;;
    ru:mk_releases) _f='ограничения списка релизов в 1.x не используются' ;;
    en:mk_releases) _f='release list limits are not used in 1.x' ;;
    ru:mk_config_path) _f='путь к конфигу Telemt панель узнаёт через его API' ;;
    en:mk_config_path) _f='the panel learns the Telemt config path from its API' ;;
    ru:migrate_done) _f='Конфиг переведён в формат 1.x: %s' ;;
    en:migrate_done) _f='Config converted to the 1.x format: %s' ;;

    # ── uninstall ──
    ru:uninstall_q) _f='Удалить сервис, бинарь и политику sudo? Конфиг и данные останутся.' ;;
    en:uninstall_q) _f='Remove the service, binary and sudo policy? Config and data are kept.' ;;
    ru:purge_q) _f='Удалить ВСЁ: сервис, бинарь, sudo, конфиг %s, данные %s и пользователя %s?' ;;
    en:purge_q) _f='Remove EVERYTHING: service, binary, sudo, config %s, data %s and user %s?' ;;
    ru:u_service) _f='Сервис остановлен и удалён' ;;
    en:u_service) _f='Service stopped and removed' ;;
    ru:u_binary) _f='Бинарь удалён' ;;
    en:u_binary) _f='Binary removed' ;;
    ru:u_sudoers) _f='Политика sudo удалена' ;;
    en:u_sudoers) _f='Sudo policy removed' ;;
    ru:u_kept) _f='Сохранены: %s и %s. Полное удаление: sh install.sh purge' ;;
    en:u_kept) _f='Kept: %s and %s. Full removal: sh install.sh purge' ;;
    ru:u_purged) _f='Конфиг, данные и пользователь удалены' ;;
    en:u_purged) _f='Config, data and user removed' ;;
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
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

ensure_temp_dir() {
  if [ -z "$TEMP_DIR" ]; then
    TEMP_DIR=$(mktemp -d)
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

# write_root_file PATH MODE [OWNER] — stdin → PATH atomically via install(1).
write_root_file() {
  _path="$1"; _mode="$2"; _owner="${3:-}"
  ensure_temp_dir
  _tmp="$TEMP_DIR/write.$$"
  cat >"$_tmp"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s--- would write %s (mode %s%s) ---%s\n' "$C_DIM" "$_path" "$_mode" "${_owner:+, owner $_owner}" "$C_RESET"
    sed 's/^/  │ /' "$_tmp"
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
# ("000" when the connection failed). Works with curl, GNU wget, busybox wget.
http_get() {
  _url="$1"; _hdr="${2:-}"
  ensure_temp_dir
  : >"$HTTP_BODY"
  if has curl; then
    if [ -n "$_hdr" ]; then
      _code=$(curl -s -m 8 -o "$HTTP_BODY" -w '%{http_code}' -H "Authorization: $_hdr" "$_url" 2>/dev/null) || _code="000"
    else
      _code=$(curl -s -m 8 -o "$HTTP_BODY" -w '%{http_code}' "$_url" 2>/dev/null) || _code="000"
    fi
    printf '%s' "${_code:-000}"
    return 0
  fi
  _err="$TEMP_DIR/http.err"
  if [ -n "$_hdr" ]; then
    wget -q -T 8 -O "$HTTP_BODY" -S --header="Authorization: $_hdr" "$_url" >"$_err" 2>&1 && _rc=0 || _rc=$?
  else
    wget -q -T 8 -O "$HTTP_BODY" -S "$_url" >"$_err" 2>&1 && _rc=0 || _rc=$?
  fi
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

detect_existing() {
  EXISTING="none"
  if [ -f "$CONFIG_FILE" ]; then
    if [ -n "$(toml_value "$CONFIG_FILE" auth jwt_secret)" ] || grep -q '^[[:space:]]*\[panel\]' "$CONFIG_FILE"; then
      EXISTING="v0"
    else
      EXISTING="v1"
    fi
  fi
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
  detect_existing
  detect_telemt
}

print_detection() {
  kv "$(t d_arch)" "$ARCH ($LIBC)"
  kv "$(t d_init)" "$INIT"
  if [ "$HAS_SUDO" = 1 ]; then
    kv "$(t d_sudo)" "$(t d_available)"
  else
    kv "$(t d_sudo)" "$(t d_missing)"
  fi
  case "$EXISTING" in
    none) kv "$(t d_existing)" "$(t d_existing_none)" ;;
    v1) kv "$(t d_existing)" "$(t d_existing_v1 "$CONFIG_FILE")" ;;
    v0) kv "$(t d_existing)" "$(t d_existing_v0 "$CONFIG_FILE")" ;;
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
  if [ "$L" = "ru" ]; then
    _c_top="# Панель никогда не переписывает этот файл: настройки из UI живут в store."
    _c_listen="# Адрес панели. За reverse proxy на подпути добавьте base_path = \"/panel\"."
    _c_data="# Каталог состояния (сессии, журнал обновлений). Пусто — только RAM."
    _c_telemt="# Telemt HTTP API: [server.api] в конфиге Telemt."
    _c_auth="# Хеш пароля: telemt-panel hash-password"
    _c_sub="# Страница подписки /sub/<token>. secret — ключ HMAC для токенов."
    _c_host="# Имена сервисов для рестарта и чтения журнала (auto-детект init-системы)."
    _c_upd="# Пути бинарей, которые заменяет обновление из панели."
    _c_priv="# sudo — узкая политика в $SUDOERS_FILE; direct — панель работает от root."
  else
    _c_top="# The panel never rewrites this file: settings changed in the UI live in the store."
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
driver = "memory"

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

# sudoers_path_ok PATH — sudoers rules cannot carry whitespace safely.
sudoers_path_ok() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[[:space:]]*) return 1 ;;
  esac
  return 0
}

# gen_sudoers — exactly the commands the panel probes with `sudo -n -l` at
# startup (httpapi.updatePrivilegeProbeOps × host.SudoRunner) plus the
# restart argv of the detected ServiceManager. No wildcards.
gen_sudoers() {
  _cp=$(command -v cp); _chmod=$(command -v chmod); _mv=$(command -v mv)
  _staging="$DATA_DIR/staging"
  for _p in "$_cp" "$_chmod" "$_mv" "$_staging" "$TELEMT_BIN" "$PANEL_BIN"; do
    sudoers_path_ok "$_p" || die "sudoers: path with whitespace or not absolute: $_p"
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
  if ! has sha256sum && ! has sha256 && ! has openssl; then
    warn "$(t no_sha)"
  fi
  ok "$(t prereq_ok)"
}

# ═════════════════════════════════════════════════════════════════════════════
#  Questions
# ═════════════════════════════════════════════════════════════════════════════

# check_telemt_api URL HEADER — prints "ok VERSION" | "auth CODE" | "refused" | "other CODE".
check_telemt_api() {
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

ask_listen() {
  blank
  explain x_listen
  while :; do
    ask LISTEN q_listen "${TP_LISTEN:-0.0.0.0:8080}"
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

collect_answers() {
  if [ "$ASSUME_YES" = 1 ] && [ -z "${TP_TELEMT_URL:-}" ] && [ -z "$TELEMT_URL_DETECTED" ]; then
    warn "$(t missing_env TP_TELEMT_URL)"
  fi
  ask_telemt_connection
  ask_listen
  ask_admin
  ask_subpage
  ask_telemt_paths
  ask_run_as
  SUBPAGE_SECRET=$(gen_secret)
}

print_summary() {
  if [ -n "$BINARY_FILE" ]; then
    kv "$(t s_version)" "$(t s_local_binary "$BINARY_FILE")"
  else
    kv "$(t s_version)" "${REQ_VERSION:-$(t s_latest)}"
  fi
  kv "$(t s_listen)" "$LISTEN"
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

setup_dirs() {
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
  _asset="$BINARY_NAME-$ARCH-linux-$LIBC.tar.gz"
  _base="https://github.com/$REPO/releases/download/$INSTALLED_TAG"
  _tar="$TEMP_DIR/$_asset"
  say "$(t a_download "$_asset ($INSTALLED_TAG)")"
  download "$_base/$_asset" "$_tar" || die "$(t a_download_fail "$_asset" "$INSTALLED_TAG")"

  _sum="$TEMP_DIR/$_asset.sha256"
  _actual=$(sha256_of "$_tar")
  if [ -z "$_actual" ]; then
    warn "$(t no_sha)"
  elif download "$_base/$_asset.sha256" "$_sum" 2>/dev/null; then
    _expected=$(awk '{print $1}' "$_sum" | head -n 1 | tr 'A-F' 'a-f')
    if [ "$_expected" = "$_actual" ]; then
      ok "$(t a_checksum_ok)"
    else
      die "$(t a_checksum_fail)"
    fi
  else
    warn "$(t a_checksum_missing)"
  fi

  mkdir -p "$TEMP_DIR/extract"
  tar -xzf "$_tar" -C "$TEMP_DIR/extract"
  STAGED_BIN="$TEMP_DIR/extract/$BINARY_NAME"
  [ -f "$STAGED_BIN" ] || die "$(t a_extract_fail "$BINARY_NAME")"
  chmod 0755 "$STAGED_BIN"
}

install_binary() {
  run install -m 0755 "$STAGED_BIN" "$PANEL_BIN"
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
}

print_done() {
  host_port_split "$LISTEN" || return 0
  say "$(t done_open)"
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

# load_v1_config — answers needed for sudoers/service from an existing 1.x config.
load_v1_config() {
  _v=$(toml_value "$CONFIG_FILE" "" listen); [ -n "$_v" ] && LISTEN="$_v"
  _v=$(toml_value "$CONFIG_FILE" "" data_dir); [ -n "$_v" ] && DATA_DIR="$_v"
  _v=$(toml_value "$CONFIG_FILE" auth username); [ -n "$_v" ] && ADMIN_USER="$_v"
  _v=$(toml_value "$CONFIG_FILE" host telemt_service); [ -n "$_v" ] && TELEMT_SVC="$_v"
  _v=$(toml_value "$CONFIG_FILE" updates telemt_binary_path); TELEMT_BIN="${_v:-/bin/telemt}"
  _v=$(toml_value "$CONFIG_FILE" updates panel_binary_path); [ -n "$_v" ] && PANEL_BIN="$_v"
  _v=$(toml_value "$CONFIG_FILE" privileges mode)
  case "$_v" in
    direct) RUN_AS="root" ;;
    sudo) RUN_AS="user" ;;
    *) if [ "$INIT" = "procd" ] || [ "$HAS_SUDO" != 1 ]; then RUN_AS="root"; else RUN_AS="user"; fi ;;
  esac
  # A 1.x install that still runs as a service user keeps doing so.
  if [ "$INIT" = "systemd" ] && [ -f "$SERVICE_FILE" ] && grep -q "^User=$SYSTEM_USER" "$SERVICE_FILE"; then
    RUN_AS="user"
  fi
}

# migrate_v0_config OLD_FILE NEW_FILE — converts a 0.x config; prints the
# list of keys without a 1.x equivalent. Answer globals are filled from the
# old file so gen_config can render the new one.
migrate_v0_config() {
  _old="$1"; _new="$2"
  _v=$(toml_value "$_old" "" listen); [ -n "$_v" ] && LISTEN="$_v"
  _v=$(toml_value "$_old" "" data_dir); [ -n "$_v" ] && DATA_DIR="$_v"
  V0_BASE_PATH=$(toml_value "$_old" "" base_path)
  V0_TRUSTED_PROXIES=$(toml_value "$_old" "" trusted_proxies)
  TELEMT_URL=$(toml_value "$_old" telemt url)
  TELEMT_AUTH=$(toml_value "$_old" telemt auth_header)
  V0_EDIT_MODE=$(toml_value "$_old" telemt config_edit_mode)
  _v=$(toml_value "$_old" telemt binary_path); TELEMT_BIN="${_v:-/bin/telemt}"
  _v=$(toml_value "$_old" telemt service_name); TELEMT_SVC="${_v:-telemt}"
  V0_TELEMT_CONTAINER=$(toml_value "$_old" telemt container_name)
  V0_TELEMT_REPO=$(toml_value "$_old" telemt github_repo)
  _v=$(toml_value "$_old" panel binary_path); [ -n "$_v" ] && PANEL_BIN="$_v"
  _v=$(toml_value "$_old" panel service_name); [ -n "$_v" ] && SERVICE_NAME="$_v"
  V0_PANEL_REPO=$(toml_value "$_old" panel github_repo)
  V0_GITHUB_TOKEN=$(toml_value "$_old" panel github_token)
  _v=$(toml_value "$_old" auth username); [ -n "$_v" ] && ADMIN_USER="$_v"
  PASS_HASH=$(toml_value "$_old" auth password_hash)
  V0_SESSION_TTL=$(toml_value "$_old" auth session_ttl)
  SUBPAGE_SECRET=$(gen_secret)

  [ -n "$TELEMT_URL" ] || die "telemt.url missing in $_old"
  [ -n "$PASS_HASH" ] || die "auth.password_hash missing in $_old"

  EXTRA_TOP=""; EXTRA_TELEMT=""; EXTRA_AUTH=""; EXTRA_HOST=""; EXTRA_UPDATES=""
  [ -n "$V0_BASE_PATH" ] && EXTRA_TOP="${EXTRA_TOP}${NL}base_path = \"$(toml_escape "$V0_BASE_PATH")\""
  [ -n "$V0_TRUSTED_PROXIES" ] && EXTRA_TOP="${EXTRA_TOP}${NL}trusted_proxies = $V0_TRUSTED_PROXIES"
  [ -n "$V0_EDIT_MODE" ] && EXTRA_TELEMT="config_edit_mode = \"$(toml_escape "$V0_EDIT_MODE")\""
  [ -n "$V0_SESSION_TTL" ] && EXTRA_AUTH="session_ttl = \"$(toml_escape "$V0_SESSION_TTL")\""
  [ -n "$V0_TELEMT_CONTAINER" ] && EXTRA_HOST="telemt_container = \"$(toml_escape "$V0_TELEMT_CONTAINER")\""
  [ -n "$V0_TELEMT_REPO" ] && EXTRA_UPDATES="${EXTRA_UPDATES}${NL}telemt_repo = \"$(toml_escape "$V0_TELEMT_REPO")\""
  [ -n "$V0_PANEL_REPO" ] && EXTRA_UPDATES="${EXTRA_UPDATES}${NL}panel_repo = \"$(toml_escape "$V0_PANEL_REPO")\""
  [ -n "$V0_GITHUB_TOKEN" ] && EXTRA_UPDATES="${EXTRA_UPDATES}${NL}github_token = \"$(toml_escape "$V0_GITHUB_TOKEN")\""
  EXTRA_TOP="${EXTRA_TOP#"$NL"}"
  EXTRA_UPDATES="${EXTRA_UPDATES#"$NL"}"
  gen_config >"$_new"

  # Keys with no 1.x home, reported with a reason.
  MIGRATE_SKIPPED=""
  _skip() { MIGRATE_SKIPPED="$MIGRATE_SKIPPED$NL  $1 — $(t "$2")"; }
  [ -n "$(toml_value "$_old" auth jwt_secret)" ] && _skip "auth.jwt_secret" mk_jwt
  grep -q '^[[:space:]]*\[telemt\.auto_update\]\|^[[:space:]]*\[panel\.auto_update\]' "$_old" 2>/dev/null && _skip "*.auto_update" mk_auto_update
  grep -q '^[[:space:]]*\[tls\]' "$_old" 2>/dev/null && _skip "tls.*" mk_tls
  grep -q '^[[:space:]]*\[geoip\]' "$_old" 2>/dev/null && _skip "geoip.*" mk_geoip
  grep -q '^[[:space:]]*\[users\]' "$_old" 2>/dev/null && _skip "users.*" mk_users
  { [ -n "$(toml_value "$_old" panel max_newer_releases)" ] || [ -n "$(toml_value "$_old" panel max_older_releases)" ]; } && _skip "panel.max_*_releases" mk_releases
  [ -n "$(toml_value "$_old" telemt config_path)" ] && _skip "telemt.config_path" mk_config_path
  return 0
}

do_migrate() {
  step 3 step_migrate
  explain migrate_intro "$CONFIG_FILE"
  blank
  ask_choice _c migrate_q 1 "1 2"
  if [ "$_c" != 1 ]; then
    say "$(t aborted)"
    exit 0
  fi
  ask_subpage
  ask_run_as

  ensure_temp_dir
  _old_copy="$TEMP_DIR/config.v0.toml"
  if [ -r "$CONFIG_FILE" ]; then
    cat "$CONFIG_FILE" >"$_old_copy"
  else
    $SUDO cat "$CONFIG_FILE" >"$_old_copy"
  fi
  _backup="$CONFIG_FILE.0x-$(date +%Y%m%d-%H%M%S)"
  migrate_v0_config "$_old_copy" "$TEMP_DIR/config.v1.toml"
  apply_layout_from_answers

  blank
  step 4 step_summary
  print_summary
  blank
  confirm apply_q || { say "$(t aborted)"; exit 0; }

  step 5 step_apply
  _owner="root"; [ "$RUN_AS" = "user" ] && _owner="$SYSTEM_USER"
  write_root_file "$_backup" 0600 "$_owner" <"$_old_copy"
  ok "$(t migrate_backup "$_backup")"
  create_user
  setup_dirs
  fetch_release
  install_binary
  write_root_file "$CONFIG_FILE" 0600 "$_owner" <"$TEMP_DIR/config.v1.toml"
  ok "$(t migrate_done "$CONFIG_FILE")"
  if [ -n "$MIGRATE_SKIPPED" ]; then
    warn "$(t migrate_skipped_title)"
    printf '%s\n' "${MIGRATE_SKIPPED#"$NL"}"
  fi
  # 0.x staging leftovers (backup copies of both binaries) are not used by 1.x.
  run_quiet sh -c "rm -f '$DATA_DIR/staging/'*.bak"
  install_sudoers
  install_service
  start_service

  step 6 step_done
  print_done
}

# apply_layout_from_answers — PANEL_BIN may have come from an old config;
# keep BIN_DIR and SERVICE_FILE consistent with it.
apply_layout_from_answers() {
  BIN_DIR=$(dirname "$PANEL_BIN")
  case "$INIT" in
    systemd) SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service" ;;
    *) SERVICE_FILE="/etc/init.d/$SERVICE_NAME" ;;
  esac
}

do_update_existing() {
  step 3 step_update
  load_v1_config
  apply_layout_from_answers
  explain update_intro "$CONFIG_FILE"
  blank
  kv "$(t s_version)" "${BINARY_FILE:-${REQ_VERSION:-$(t s_latest)}}"
  kv "$(t s_run_as)" "$([ "$RUN_AS" = user ] && printf '%s' "$SYSTEM_USER" || printf 'root')"
  kv "$(t s_service)" "$INIT: $SERVICE_FILE"
  blank
  confirm continue_q || { say "$(t aborted)"; exit 0; }

  step 4 step_apply
  create_user
  setup_dirs
  fetch_release
  install_binary
  ok "$(t a_config_kept "$CONFIG_FILE")"
  install_sudoers
  install_service
  start_service

  step 5 step_done
  print_done
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
    v0) do_migrate; return 0 ;;
    v1) do_update_existing; return 0 ;;
  esac

  step 3 step_questions
  collect_answers
  apply_layout_from_answers

  step 4 step_summary
  print_summary
  blank
  confirm apply_q || { say "$(t aborted)"; exit 0; }

  step 5 step_apply
  create_user
  setup_dirs
  fetch_release
  hash_password
  install_binary
  write_config
  install_sudoers
  install_service
  start_service

  step 6 step_done
  print_done
}

stop_and_disable_service() {
  case "$INIT" in
    systemd)
      run_quiet systemctl stop "$SERVICE_NAME"
      run_quiet systemctl disable "$SERVICE_NAME" ;;
    openrc)
      run_quiet rc-service "$SERVICE_NAME" stop
      run_quiet rc-update del "$SERVICE_NAME" default ;;
    procd)
      run_quiet "$SERVICE_FILE" stop
      run_quiet "$SERVICE_FILE" disable ;;
    sysvinit)
      run_quiet "$SERVICE_FILE" stop
      if has update-rc.d; then run_quiet update-rc.d -f "$SERVICE_NAME" remove
      elif has chkconfig; then run_quiet chkconfig --del "$SERVICE_NAME"; fi ;;
  esac
}

do_uninstall() {
  require_tty
  check_prereqs_quiet
  detect_init
  apply_layout
  detect_existing
  if [ "$EXISTING" = "v1" ]; then
    load_v1_config
    apply_layout_from_answers
  fi
  if [ ! -f "$PANEL_BIN" ] && [ ! -f "$SERVICE_FILE" ] && [ ! -f "$CONFIG_FILE" ]; then
    say "$(t u_nothing)"
    return 0
  fi
  if [ "$CMD" = "uninstall" ]; then
    confirm_danger uninstall_q || { say "$(t aborted)"; exit 0; }
  fi
  if [ -f "$SERVICE_FILE" ]; then
    stop_and_disable_service
    run rm -f "$SERVICE_FILE"
    [ "$INIT" = "systemd" ] && run_quiet systemctl daemon-reload
    ok "$(t u_service)"
  fi
  if [ -f "$PANEL_BIN" ]; then
    run rm -f "$PANEL_BIN" "$PANEL_BIN.bak" "$PANEL_BIN.tmp" "$PANEL_BIN.bak.tmp"
    ok "$(t u_binary)"
  fi
  if [ -f "$SUDOERS_FILE" ]; then
    run rm -f "$SUDOERS_FILE"
    ok "$(t u_sudoers)"
  fi
  if [ "$CMD" = "uninstall" ]; then
    say "$(t u_kept "$CONFIG_DIR" "$DATA_DIR")"
  fi
}

do_purge() {
  require_tty
  check_prereqs_quiet
  detect_init
  apply_layout
  detect_existing
  if [ "$EXISTING" = "v1" ]; then
    load_v1_config
    apply_layout_from_answers
  fi
  confirm_danger purge_q "$CONFIG_DIR" "$DATA_DIR" "$SYSTEM_USER" || { say "$(t aborted)"; exit 0; }
  do_uninstall
  run rm -rf "$CONFIG_DIR" "$DATA_DIR"
  [ -f "$LOG_FILE" ] && run rm -f "$LOG_FILE"
  if id "$SYSTEM_USER" >/dev/null 2>&1; then
    if has userdel; then run_quiet userdel "$SYSTEM_USER"; else run_quiet deluser "$SYSTEM_USER"; fi
  fi
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
