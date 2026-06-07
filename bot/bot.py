import os
import telebot
import requests
import json
import secrets
import logging
import time
import sqlite3
import re
import threading
import io
import qrcode
import sys
try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None
from logging.handlers import RotatingFileHandler
from requests.exceptions import RequestException

# =========================================================
# CONFIG
# =========================================================

def _load_panel_config(path):
    """Load panel config.toml and return parsed dict, or {} on error."""
    if not tomllib or not path:
        return {}
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except Exception:
        return {}

_PANEL_CONFIG_PATH = os.getenv("PANEL_CONFIG_PATH", "")
_panel_cfg = _load_panel_config(_PANEL_CONFIG_PATH)
_tg_section = _panel_cfg.get("telegram", {})

TOKEN = os.getenv("BOT_TOKEN") or _tg_section.get("bot_token", "")

_admin_ids_env = os.getenv("ADMIN_IDS", "")
if _admin_ids_env:
    ADMIN_IDS = set(int(x.strip()) for x in _admin_ids_env.split(",") if x.strip().isdigit())
else:
    ADMIN_IDS = set(_tg_section.get("admin_ids", []))

_telemt_section = _panel_cfg.get("telemt", {})
API_URL = os.getenv("API_URL") or _telemt_section.get("url", "http://localhost:9091")
if not API_URL.endswith("/v1"):
    API_URL = API_URL.rstrip("/") + "/v1"

# Auto-detect proxy domain from telemt config (via panel's telemt.config_path).
# Falls back to env vars so manual override is still possible.
_telemt_config_path = _telemt_section.get("config_path", "")
_telemt_cfg = _load_panel_config(_telemt_config_path)
_links_cfg = _telemt_cfg.get("general", {}).get("links", {})
_censorship_cfg = _telemt_cfg.get("censorship", {})

DOMAIN = (os.getenv("PROXY_DOMAIN") or _links_cfg.get("public_host", ""))
PORT = int(os.getenv("PROXY_PORT") or _links_cfg.get("public_port", 4448))
TLS_DOMAIN = (os.getenv("PROXY_TLS_DOMAIN") or _censorship_cfg.get("tls_domain", "") or DOMAIN)

TIMEOUT = 10
MONITOR_INTERVAL = 60
POLLING_RESTART_DELAY = 15

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, "users.db")

MAX_TCP_CONNS = _tg_section.get("default_max_tcp_conns", 0) or 50
MAX_UNIQUE_IPS_ALERT = _tg_section.get("default_max_unique_ips", 0) or 5

BAN_WARNING = (
    "\n\n⚠️ <b>ВАЖНО:</b> Ссылка персональная. Запрещено передавать её другим людям. При нарушении доступ блокируется."
)

# =========================================================
# LOGGING
# =========================================================

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")

stream_handler = logging.StreamHandler()
stream_handler.setFormatter(formatter)

file_handler = RotatingFileHandler(os.path.join(BASE_DIR, "bot.log"), maxBytes=2*1024*1024, backupCount=5, encoding="utf-8")
file_handler.setFormatter(formatter)

logger.addHandler(stream_handler)
logger.addHandler(file_handler)

if not TOKEN:
    logger.critical("BOT_TOKEN is not set! Set BOT_TOKEN env variable or configure [telegram] bot_token in panel config.")
    sys.exit(1)

if not ADMIN_IDS:
    logger.warning("ADMIN_IDS is empty! Set ADMIN_IDS env variable or configure [telegram] admin_ids in panel config.")

if not DOMAIN:
    logger.warning("PROXY_DOMAIN is not set! Proxy links will not work. Set PROXY_DOMAIN env variable.")

bot = telebot.TeleBot(TOKEN)
db_lock = threading.Lock()
api_session = requests.Session()

_auth_header = os.getenv("TELEMT_AUTH_HEADER") or _telemt_section.get("auth_header", "")
if _auth_header:
    api_session.headers["X-Auth"] = _auth_header

api_offline_count = 0
API_OFFLINE_THRESHOLD = 3

# =========================================================
# DATABASE
# =========================================================

def db_query(query, params=(), fetch=False, silent=False):
    with db_lock:
        try:
            with sqlite3.connect(DB_FILE, timeout=20) as conn:
                cursor = conn.cursor()
                cursor.execute(query, params)
                if fetch: return cursor.fetchall()
                conn.commit()
                return True
        except sqlite3.Error as e:
            if not silent: logger.exception(f"Database error: {e}")
            return [] if fetch else False

def init_db():
    db_query("CREATE TABLE IF NOT EXISTS users (proxy_name TEXT PRIMARY KEY, tg_id INTEGER, secret TEXT)")
    db_query("CREATE TABLE IF NOT EXISTS known_ips (proxy_name TEXT, ip TEXT, last_seen INTEGER, UNIQUE(proxy_name, ip))")
    db_query("CREATE TABLE IF NOT EXISTS fsm_state (user_id INTEGER PRIMARY KEY, state TEXT, data TEXT)")
    db_query("CREATE TABLE IF NOT EXISTS requests (tg_id INTEGER PRIMARY KEY, tg_username TEXT, desired_name TEXT)")
    db_query("CREATE TABLE IF NOT EXISTS banned_users (tg_id INTEGER PRIMARY KEY, proxy_name TEXT, reason TEXT)")
    db_query("CREATE TABLE IF NOT EXISTS reply_map (admin_msg_id INTEGER PRIMARY KEY, client_uid INTEGER, created_at INTEGER)")
    db_query("ALTER TABLE known_ips ADD COLUMN last_seen INTEGER", silent=True)

def get_user_by_tg_id(tg_id):
    res = db_query("SELECT proxy_name, secret FROM users WHERE tg_id=?", (tg_id,), fetch=True)
    return res[0] if res else None

def clean_user_data(proxy_name):
    db_query("DELETE FROM users WHERE proxy_name=?", (proxy_name,))
    db_query("DELETE FROM known_ips WHERE proxy_name=?", (proxy_name,))
    logger.info(f"Cleaned up DB records for user: {proxy_name}")

# =========================================================
# HELPERS
# =========================================================

def is_valid_proxy_name(name): return bool(re.fullmatch(r"[a-zA-Z0-9_]{3,32}", name))

def get_qr(data):
    qr = qrcode.QRCode(box_size=10, border=5)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    bio = io.BytesIO()
    img.save(bio, "PNG")
    bio.seek(0)
    return bio

def format_traffic(octets):
    if octets < 1024**3: return f"{round(octets / 1024**2, 2)} MB"
    return f"{round(octets / 1024**3, 2)} GB"

def build_proxy_link(secret):
    if not secret or not DOMAIN: return None
    tls_hex = TLS_DOMAIN.encode().hex()
    return f"tg://proxy?server={DOMAIN}&port={PORT}&secret=ee{secret}{tls_hex}"

# =========================================================
# API CORE & SYNC
# =========================================================

def api_request(method, endpoint, payload=None):
    url = f"{API_URL}{endpoint}"
    try:
        if method == "GET": r = api_session.get(url, timeout=TIMEOUT)
        elif method == "POST": r = api_session.post(url, json=payload, timeout=TIMEOUT)
        elif method == "DELETE": r = api_session.delete(url, timeout=TIMEOUT)
        else: return None

        if r.status_code == 409: return {"ok": False, "error": "conflict"}
        r.raise_for_status()
        return r.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"API {method} {endpoint} failed: {e}")
        return None

def extract_secret_from_dict(u_dict):
    links_str = str(u_dict.get('links', {}))
    match = re.search(r"secret=ee([a-f0-9]{32})", links_str)
    if match: return match.group(1)
    match_short = re.search(r"secret=ee([a-f0-9]{16})", links_str)
    return match_short.group(1) if match_short else None

def sync_api_to_db():
    res = api_request("GET", "/users")
    if not res or not res.get("data"): return False

    db_users_raw = db_query("SELECT proxy_name, secret FROM users", fetch=True)
    db_users = {u[0]: u[1] for u in db_users_raw}

    for u in res.get("data", []):
        name = u['username']
        secret = extract_secret_from_dict(u)
        if name not in db_users:
            db_query("INSERT INTO users (proxy_name, secret) VALUES (?, ?)", (name, secret))
        elif db_users[name] is None and secret is not None:
            db_query("UPDATE users SET secret=? WHERE proxy_name=?", (secret, name))
    return True

# =========================================================
# FSM
# =========================================================

def set_state(uid, state, data=None):
    db_query("INSERT OR REPLACE INTO fsm_state VALUES (?, ?, ?)", (uid, state, json.dumps(data or {})))

def get_state(uid):
    res = db_query("SELECT state, data FROM fsm_state WHERE user_id=?", (uid,), fetch=True)
    if not res: return None, {}
    try: return res[0][0], json.loads(res[0][1])
    except: return None, {}

def clear_state(uid): db_query("DELETE FROM fsm_state WHERE user_id=?", (uid,))

# =========================================================
# HANDLERS: START & USERS
# =========================================================

@bot.message_handler(commands=["start", "cancel"])
def cmd_start(message):
    uid = message.from_user.id
    clear_state(uid)

    if uid in ADMIN_IDS:
        markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
        markup.add("📊 Статистика", "📥 Заявки", "➕ Добавить", "📢 Рассылка", "⚫️ Черный список", "💾 Бэкап")

        sync_api_to_db()
        res = api_request("GET", "/users")

        total_clients = 0
        online_clients = 0
        total_octets = 0

        if res and res.get("data"):
            total_clients = len(res["data"])
            for u in res["data"]:
                total_octets += u.get("total_octets", 0)
                if len(u.get("active_unique_ips_list", []) or []) > 0:
                    online_clients += 1

        traffic_str = format_traffic(total_octets)

        dashboard_msg = (
            f"💎 <b>Админ панель прокси telemt - {DOMAIN}</b>\n\n"
            f"🟢 Клиентов онлайн: <b>{online_clients}</b>\n"
            f"👥 Клиентов всего: <b>{total_clients}</b>\n"
            f"📊 Суммарный трафик: <b>{traffic_str}</b>"
        )
        bot.send_message(message.chat.id, dashboard_msg, reply_markup=markup, parse_mode="HTML")
        return

    if db_query("SELECT 1 FROM banned_users WHERE tg_id=?", (uid,), fetch=True):
        return bot.send_message(message.chat.id, "🚫 Вам отказано в доступе. Ваш аккаунт заблокирован.")

    user = get_user_by_tg_id(uid)
    if user:
        markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
        markup.add("📊 Моя статистика", "🔗 Моя ссылка")
        bot.send_message(message.chat.id, "👋 Добро пожаловать!\nИспользуйте меню ниже.", reply_markup=markup)
        return

    req = db_query("SELECT 1 FROM requests WHERE tg_id=?", (uid,), fetch=True)
    if req:
        bot.send_message(message.chat.id, "⏳ Ваша заявка находится на рассмотрении. Ожидайте решения администратора.")
    else:
        markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True)
        markup.add("📝 Регистрация")
        bot.send_message(message.chat.id, "👋 Добро пожаловать!\nДля получения доступа к прокси подайте заявку.", reply_markup=markup)

@bot.message_handler(func=lambda m: m.text == "📝 Регистрация")
def req_start(message):
    uid = message.from_user.id
    if uid in ADMIN_IDS or get_user_by_tg_id(uid): return
    if db_query("SELECT 1 FROM banned_users WHERE tg_id=?", (uid,), fetch=True):
        return bot.send_message(message.chat.id, "🚫 Доступ запрещен. Аккаунт заблокирован.")
    if db_query("SELECT 1 FROM requests WHERE tg_id=?", (uid,), fetch=True):
        return bot.send_message(message.chat.id, "⏳ Ваша заявка уже на рассмотрении.")

    tg_username = message.from_user.username
    desired_name = re.sub(r"[^a-zA-Z0-9_]", "", tg_username)[:32] if tg_username else f"user_{uid}"[:32]
    if len(desired_name) < 3: desired_name = f"user_{uid}"[:32]

    sync_api_to_db()
    if db_query("SELECT 1 FROM users WHERE proxy_name=?", (desired_name,), fetch=True):
        desired_name = f"{desired_name}_{str(uid)[-4:]}"[:32]

    db_query("INSERT OR REPLACE INTO requests (tg_id, tg_username, desired_name) VALUES (?, ?, ?)", (uid, tg_username or "Без_юзернейма", desired_name))
    bot.send_message(message.chat.id, "✅ Заявка отправлена!", reply_markup=telebot.types.ReplyKeyboardRemove())

    for admin in ADMIN_IDS:
        try:
            markup = telebot.types.InlineKeyboardMarkup()
            markup.add(
                telebot.types.InlineKeyboardButton("✅ Одобрить", callback_data=f"req_y_{uid}"),
                telebot.types.InlineKeyboardButton("❌ Отклонить", callback_data=f"req_n_{uid}")
            )
            bot.send_message(admin, f"🔔 Новая заявка\n👤 @{tg_username or 'Без_юзернейма'} (ID: {uid})\n🏷 Имя: {desired_name}", reply_markup=markup)
        except: pass

@bot.message_handler(func=lambda m: m.text == "📊 Моя статистика")
def user_stats(message):
    user = get_user_by_tg_id(message.from_user.id)
    if not user: return
    name = user[0]
    res = api_request("GET", "/users")
    if not res: return bot.send_message(message.chat.id, "❌ Сервер временно недоступен.")
    user_data = next((u for u in res.get("data", []) if u['username'] == name), None)
    if not user_data: return bot.send_message(message.chat.id, "❌ Данные не найдены.")

    traffic = format_traffic(user_data.get("total_octets", 0))
    ips = ", ".join(user_data.get("active_unique_ips_list", [])) or "нет"
    bot.send_message(message.chat.id, f"👤 Логин: <code>{name}</code>\n📊 Трафик: <code>{traffic}</code>\n📍 IP: <code>{ips}</code>", parse_mode="HTML")

@bot.message_handler(func=lambda m: m.text == "🔗 Моя ссылка")
def user_link(message):
    user = get_user_by_tg_id(message.from_user.id)
    if not user: return
    link = build_proxy_link(user[1])
    if not link: return bot.send_message(message.chat.id, "❌ Ошибка генерации ссылки.")

    caption_text = f"🚀 Ваша ссылка для подключения:{BAN_WARNING}"
    try:
        bot.send_photo(message.chat.id, get_qr(link), caption=caption_text, parse_mode="HTML")
    except:
        bot.send_message(message.chat.id, caption_text, parse_mode="HTML")

    bot.send_message(message.chat.id, link)

# =========================================================
# ADMIN HANDLERS
# =========================================================

@bot.message_handler(func=lambda m: m.text == "💾 Бэкап")
def backup_db(message):
    if message.from_user.id not in ADMIN_IDS: return
    try:
        with open(DB_FILE, "rb") as db: bot.send_document(message.chat.id, db, caption="💾 Резервная копия БД")
    except Exception as e: bot.send_message(message.chat.id, f"❌ Ошибка: {e}")

@bot.message_handler(func=lambda m: m.text == "⚫️ Черный список")
def view_blacklist(message):
    if message.from_user.id not in ADMIN_IDS: return
    banned = db_query("SELECT tg_id, proxy_name, reason FROM banned_users", fetch=True)
    if not banned: return bot.send_message(message.chat.id, "⚫️ Список пуст.")
    for b in banned:
        markup = telebot.types.InlineKeyboardMarkup()
        markup.add(telebot.types.InlineKeyboardButton("🔄 Разбанить", callback_data=f"unban_{b[0]}"))
        bot.send_message(message.chat.id, f"👤 ID: <code>{b[0]}</code>\n🏷 Имя: <code>{b[1]}</code>\n📝 Причина: {b[2]}", parse_mode="HTML", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("unban_"))
def unban_user(call):
    if call.from_user.id not in ADMIN_IDS: return
    tg_id = int(call.data[6:])
    if not db_query("SELECT 1 FROM banned_users WHERE tg_id=?", (tg_id,), fetch=True):
        return bot.edit_message_text("Пользователь уже разбанен.", call.message.chat.id, call.message.message_id)
    db_query("DELETE FROM banned_users WHERE tg_id=?", (tg_id,))
    bot.edit_message_text(f"✅ Пользователь разбанен.", call.message.chat.id, call.message.message_id)

@bot.message_handler(func=lambda m: m.text == "📥 Заявки")
def view_requests(message):
    if message.from_user.id not in ADMIN_IDS: return
    reqs = db_query("SELECT tg_id, tg_username, desired_name FROM requests", fetch=True)
    if not reqs: return bot.send_message(message.chat.id, "📭 Очередь пуста.")
    for r in reqs:
        markup = telebot.types.InlineKeyboardMarkup()
        markup.add(
            telebot.types.InlineKeyboardButton("✅ Одобрить", callback_data=f"req_y_{r[0]}"),
            telebot.types.InlineKeyboardButton("❌ Отклонить", callback_data=f"req_n_{r[0]}")
        )
        bot.send_message(message.chat.id, f"👤 @{r[1]} (ID: <code>{r[0]}</code>)\n🏷 Имя прокси: <code>{r[2]}</code>", parse_mode="HTML", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("req_"))
def process_request(call):
    if call.from_user.id not in ADMIN_IDS: return
    try: bot.answer_callback_query(call.id)
    except: pass

    action, tg_id = call.data[4:5], int(call.data[6:])
    req = db_query("SELECT desired_name, tg_username FROM requests WHERE tg_id=?", (tg_id,), fetch=True)
    if not req: return bot.edit_message_text("⚠️ Обработано.", call.message.chat.id, call.message.message_id)

    proxy_name, username = req[0]

    if action == 'n':
        db_query("DELETE FROM requests WHERE tg_id=?", (tg_id,))
        bot.edit_message_text(f"❌ Заявка от @{username} отклонена.", call.message.chat.id, call.message.message_id)
        try: bot.send_message(tg_id, "❌ Ваша заявка отклонена.")
        except: pass
        return

    if action == 'y':
        secret = secrets.token_hex(16)
        res = api_request("POST", "/users", {"username": proxy_name, "secret": secret, "max_tcp_conns": MAX_TCP_CONNS})

        if res and res.get("ok"):
            real_secret = secret
        elif res and res.get("error") == "conflict":
            res_users = api_request("GET", "/users")
            user_api_data = next((u for u in res_users.get("data", []) if u['username'] == proxy_name), {}) if res_users else {}
            real_secret = extract_secret_from_dict(user_api_data) or secret
        else:
            return bot.send_message(call.message.chat.id, f"❌ Ошибка API при одобрении.")

        db_query("INSERT OR REPLACE INTO users VALUES (?, ?, ?)", (proxy_name, tg_id, real_secret))
        db_query("DELETE FROM requests WHERE tg_id=?", (tg_id,))
        link = build_proxy_link(real_secret)
        bot.edit_message_text(f"✅ Одобрено: <code>{proxy_name}</code>", call.message.chat.id, call.message.message_id, parse_mode="HTML")

        try:
            markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
            markup.add("📊 Моя статистика", "🔗 Моя ссылка")
            bot.send_message(tg_id, "🎉 Ваша заявка одобрена! Вам доступно меню.", reply_markup=markup)

            if link:
                caption_text = f"🚀 Ссылка для подключения:{BAN_WARNING}"
                bot.send_photo(tg_id, get_qr(link), caption=caption_text, parse_mode="HTML")
                bot.send_message(tg_id, link)
        except: pass

@bot.message_handler(func=lambda m: m.text == "📊 Статистика")
def stats_menu(message):
    if message.from_user.id not in ADMIN_IDS: return

    sync_api_to_db()

    res = api_request("GET", "/users")
    if not res: return bot.send_message(message.chat.id, "❌ API недоступно.")

    markup = telebot.types.InlineKeyboardMarkup()
    active_count = 0

    for u in res.get("data", []):
        name = u['username']
        active_ips = u.get("active_unique_ips_list", []) or []
        if len(active_ips) > 0:
            active_count += 1
            markup.add(telebot.types.InlineKeyboardButton(f"🟢 {name}", callback_data=f"st_{name}"))

    markup.add(telebot.types.InlineKeyboardButton("Показать всех клиентов", callback_data="st_all"))

    if active_count > 0:
        bot.send_message(message.chat.id, f"Выберите клиента:\n<i>(Активных онлайн: {active_count})</i>", reply_markup=markup, parse_mode="HTML")
    else:
        bot.send_message(message.chat.id, "Активных клиентов сейчас нет.", reply_markup=markup, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: call.data == "st_all")
def show_all_stats(call):
    if call.from_user.id not in ADMIN_IDS: return
    try: bot.answer_callback_query(call.id)
    except: pass

    res = api_request("GET", "/users")
    if not res: return bot.edit_message_text("❌ API недоступно.", call.message.chat.id, call.message.message_id)

    markup = telebot.types.InlineKeyboardMarkup()
    for u in res.get("data", []):
        name = u['username']
        active_ips = u.get("active_unique_ips_list", []) or []
        status_icon = "🟢" if len(active_ips) > 0 else "⚪️"
        markup.add(telebot.types.InlineKeyboardButton(f"{status_icon} {name}", callback_data=f"st_{name}"))

    bot.edit_message_text("Все клиенты:\n<i>(🟢 Онлайн / ⚪️ Офлайн)</i>", call.message.chat.id, call.message.message_id, reply_markup=markup, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: call.data.startswith("st_") and call.data != "st_all")
def show_user_stats(call):
    name = call.data[3:]
    try: bot.answer_callback_query(call.id)
    except: pass

    res = api_request("GET", "/users")
    if not res or not res.get("data"): return bot.send_message(call.message.chat.id, "Ошибка API.")

    user_data = next((u for u in res.get("data", []) if u['username'] == name), None)
    if not user_data: return bot.send_message(call.message.chat.id, f"Данные по {name} не найдены.")

    traffic = format_traffic(user_data.get("total_octets", 0))
    ips = ", ".join(user_data.get("active_unique_ips_list", [])) or "нет"

    markup = telebot.types.InlineKeyboardMarkup(row_width=2)
    markup.add(
        telebot.types.InlineKeyboardButton("🚫 Забанить", callback_data=f"ban_ask_{name}"),
        telebot.types.InlineKeyboardButton("❌ Удалить", callback_data=f"del_ask_{name}")
    )
    markup.add(
        telebot.types.InlineKeyboardButton("🔗 Привязать TG", callback_data=f"bind_ask_{name}"),
        telebot.types.InlineKeyboardButton("✉️ Написать", callback_data=f"msg_ask_{name}")
    )
    markup.add(
        telebot.types.InlineKeyboardButton("🆔 Показать TG ID", callback_data=f"tgid_{name}"),
        telebot.types.InlineKeyboardButton("📱 Показать QR", callback_data=f"qr_{name}")
    )

    bot.edit_message_text(f"👤 <code>{name}</code>\n📊 Трафик: <code>{traffic}</code>\n📍 IP: <code>{ips}</code>", call.message.chat.id, call.message.message_id, parse_mode="HTML", reply_markup=markup, disable_web_page_preview=True)

@bot.callback_query_handler(func=lambda call: call.data.startswith("msg_ask_"))
def ask_msg_user(call):
    if call.from_user.id not in ADMIN_IDS: return
    try: bot.answer_callback_query(call.id)
    except: pass

    name = call.data[8:]
    user_data = db_query("SELECT tg_id FROM users WHERE proxy_name=?", (name,), fetch=True)
    tg_id = user_data[0][0] if user_data else None

    if not tg_id:
        return bot.send_message(call.message.chat.id, f"❌ У пользователя <b>{name}</b> не привязан Telegram.", parse_mode="HTML")

    set_state(call.from_user.id, "WAIT_MSG_TO_USER", {"tg_id": tg_id, "proxy_name": name})

    markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True)
    markup.add("Отмена")
    bot.send_message(call.message.chat.id, f"Напишите сообщение для <b>{name}</b> (можно прикрепить фото/файл):", parse_mode="HTML", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("tgid_"))
def show_tg_id(call):
    if call.from_user.id not in ADMIN_IDS: return
    name = call.data[5:]
    try: bot.answer_callback_query(call.id)
    except: pass

    user_data = db_query("SELECT tg_id FROM users WHERE proxy_name=?", (name,), fetch=True)
    tg_id = user_data[0][0] if user_data else None

    if not tg_id:
        return bot.send_message(call.message.chat.id, f"⚠️ Пользователь <b>{name}</b> не привязан к Telegram.", parse_mode="HTML")

    markup = telebot.types.InlineKeyboardMarkup()
    markup.add(telebot.types.InlineKeyboardButton("Открыть профиль", url=f"tg://user?id={tg_id}"))
    bot.send_message(call.message.chat.id, f"👤 Пользователь: <b>{name}</b>\nID Telegram: <code>{tg_id}</code>", parse_mode="HTML", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("qr_"))
def show_admin_qr(call):
    if call.from_user.id not in ADMIN_IDS: return
    name = call.data[3:]
    try: bot.answer_callback_query(call.id)
    except: pass

    db_u = db_query("SELECT secret FROM users WHERE proxy_name=?", (name,), fetch=True)
    if not db_u or not db_u[0][0]:
        return bot.send_message(call.message.chat.id, "❌ У этого пользователя нет секрета.")

    link = build_proxy_link(db_u[0][0])
    if not link:
        return bot.send_message(call.message.chat.id, "❌ PROXY_DOMAIN не настроен.")
    try:
        bot.send_photo(call.message.chat.id, get_qr(link), caption=f"🚀 QR и ссылка для <b>{name}</b>:\n\n<code>{link}</code>", parse_mode="HTML")
    except:
        bot.send_message(call.message.chat.id, "❌ Ошибка генерации QR.")

@bot.callback_query_handler(func=lambda call: call.data.startswith("ban_ask_") or call.data.startswith("del_ask_"))
def confirm_action_ask(call):
    if call.from_user.id not in ADMIN_IDS: return
    is_ban = call.data.startswith("ban_ask_")
    action = "ЗАБАНИТЬ" if is_ban else "УДАЛИТЬ"

    name = call.data[8:]
    new_data = f"ban_yes_{name}" if is_ban else f"del_yes_{name}"

    markup = telebot.types.InlineKeyboardMarkup()
    markup.add(
        telebot.types.InlineKeyboardButton(f"🚨 ДА, {action}", callback_data=new_data),
        telebot.types.InlineKeyboardButton("Отмена", callback_data="cancel_action")
    )
    bot.edit_message_text(f"⚠️ Точно {action.lower()} <code>{name}</code>?", call.message.chat.id, call.message.message_id, parse_mode="HTML", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("ban_yes_") or call.data.startswith("del_yes_"))
def confirm_action_exec(call):
    if call.from_user.id not in ADMIN_IDS: return
    try: bot.answer_callback_query(call.id, "Выполняю...")
    except: pass

    is_ban = call.data.startswith("ban_yes_")
    name = call.data[8:]

    api_request("DELETE", f"/users/{name}")

    if is_ban:
        user_data = db_query("SELECT tg_id FROM users WHERE proxy_name=?", (name,), fetch=True)
        tg_id = user_data[0][0] if user_data else None
        if tg_id:
            db_query("INSERT OR REPLACE INTO banned_users (tg_id, proxy_name, reason) VALUES (?, ?, ?)", (tg_id, name, "Ручная блокировка"))
            try: bot.send_message(tg_id, "🚫 Доступ заблокирован администратором.")
            except: pass

    clean_user_data(name)
    bot.edit_message_text(f"✅ Исполнено: <code>{name}</code>", call.message.chat.id, call.message.message_id, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: call.data.startswith("bind_ask_"))
def ask_bind_tg(call):
    if call.from_user.id not in ADMIN_IDS: return
    try: bot.answer_callback_query(call.id)
    except: pass

    proxy_name = call.data[9:]
    set_state(call.from_user.id, "WAIT_TG_CONTACT", {"proxy_name": proxy_name})

    markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True, one_time_keyboard=True)
    button = telebot.types.KeyboardButton(
        text="👤 Выбрать пользователя Telegram",
        request_users=telebot.types.KeyboardButtonRequestUsers(request_id=1, user_is_bot=False, max_quantity=1)
    )
    markup.add(button)
    markup.add(telebot.types.KeyboardButton(text="Отмена"))

    bot.send_message(call.message.chat.id, f"Выберите аккаунт Telegram, чтобы привязать его к прокси <b>{proxy_name}</b>.", parse_mode="HTML", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data == "cancel_action")
def cancel_action(call):
    bot.edit_message_text("Действие отменено.", call.message.chat.id, call.message.message_id)

@bot.callback_query_handler(func=lambda call: call.data.startswith("bantg_"))
def ban_spammer_tg(call):
    if call.from_user.id not in ADMIN_IDS: return
    try: bot.answer_callback_query(call.id, "Блокируем...")
    except: pass

    tg_id = int(call.data[6:])
    user = get_user_by_tg_id(tg_id)
    proxy_name = user[0] if user else "Спамер (без прокси)"

    db_query("INSERT OR REPLACE INTO banned_users (tg_id, proxy_name, reason) VALUES (?, ?, ?)", (tg_id, proxy_name, "Бан за спам"))

    if user:
        api_request("DELETE", f"/users/{user[0]}")
        clean_user_data(user[0])
        try: bot.send_message(tg_id, "🚫 Ваш доступ заблокирован.")
        except: pass

    new_text = f"🏷 Прокси: <code>{proxy_name}</code>\n<i>(Для ответа сделайте Reply на пересланное сообщение клиента)</i>\n\n✅ <b>TG ID {tg_id} ЗАБЛОКИРОВАН</b>"
    bot.edit_message_text(new_text, call.message.chat.id, call.message.message_id, parse_mode="HTML")

@bot.message_handler(content_types=['users_shared', 'user_shared'])
def handle_user_shared(message):
    if message.from_user.id not in ADMIN_IDS: return
    state, data = get_state(message.from_user.id)

    tg_id = None
    try:
        if hasattr(message, 'users_shared') and message.users_shared is not None:
            tg_id = message.users_shared.users[0].user_id
        elif hasattr(message, 'user_shared') and message.user_shared is not None:
            tg_id = message.user_shared.user_id
    except Exception as e:
        logger.error(f"Ошибка парсинга контакта: {e}")
        bot.send_message(message.chat.id, f"❌ Ошибка чтения контакта: {e}")
        return

    if not tg_id:
        return

    if state == "WAIT_TG_CONTACT":
        proxy_name = data.get("proxy_name")
        db_query("UPDATE users SET tg_id=? WHERE proxy_name=?", (tg_id, proxy_name))
        clear_state(message.from_user.id)

        markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
        markup.add("📊 Статистика", "📥 Заявки", "➕ Добавить", "📢 Рассылка", "⚫️ Черный список", "💾 Бэкап")
        bot.send_message(message.chat.id, f"✅ Успешно! Пользователь <b>{proxy_name}</b> привязан к TG ID <code>{tg_id}</code>.", parse_mode="HTML", reply_markup=markup)

    elif state == "WAIT_ADD_CONTACT":
        set_state(message.from_user.id, "WAIT_ADD_NAME", {"tg_id": tg_id})
        markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True)
        markup.add("Отмена")
        bot.send_message(message.chat.id, f"✅ Контакт выбран (ID: <code>{tg_id}</code>).\n\nТеперь отправьте <b>имя прокси</b> (только латиница и цифры):", parse_mode="HTML", reply_markup=markup)

# =========================================================
# FSM HANDLER
# =========================================================

@bot.message_handler(func=lambda m: m.text in ["📢 Рассылка", "➕ Добавить"])
def admin_menu_trigger(message):
    if message.from_user.id not in ADMIN_IDS: return

    if message.text == "📢 Рассылка":
        set_state(message.from_user.id, "WAIT_BROADCAST")
        markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True)
        markup.add("Отмена")
        bot.send_message(message.chat.id, "Введите текст рассылки:", reply_markup=markup)

    elif message.text == "➕ Добавить":
        set_state(message.from_user.id, "WAIT_ADD_CONTACT")

        markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True, one_time_keyboard=True)
        button = telebot.types.KeyboardButton(
            text="👤 Выбрать контакт для нового прокси",
            request_users=telebot.types.KeyboardButtonRequestUsers(request_id=2, user_is_bot=False, max_quantity=1)
        )
        markup.add(button)
        markup.add(telebot.types.KeyboardButton(text="Отмена"))

        bot.send_message(message.chat.id, "Выберите пользователя Telegram, которому хотите выдать доступ:", reply_markup=markup)

@bot.message_handler(func=lambda m: get_state(m.from_user.id)[0] is not None, content_types=['text', 'photo', 'document', 'video', 'audio', 'voice', 'sticker'])
def fsm_handler(message):
    uid = message.from_user.id
    state, data = get_state(uid)
    text = (message.text or "").strip()

    if text.lower() == "отмена" or text == "/cancel":
        clear_state(uid)
        bot.send_message(message.chat.id, "❌ Действие отменено.")
        return cmd_start(message)

    if state == "WAIT_BROADCAST":
        users = db_query("SELECT tg_id FROM users WHERE tg_id > 0", fetch=True)
        bot.send_message(message.chat.id, f"⏳ Рассылка для {len(users)} чел...")
        for u in users:
            try: bot.send_message(u[0], f"📢 <b>Уведомление:</b>\n\n{text}", parse_mode="HTML"); time.sleep(0.05)
            except: pass
        clear_state(uid); cmd_start(message)

    elif state == "WAIT_MSG_TO_USER":
        tg_id = data.get("tg_id")
        proxy_name = data.get("proxy_name")

        try:
            bot.copy_message(tg_id, message.chat.id, message.message_id)
            bot.send_message(message.chat.id, f"✅ Сообщение успешно отправлено клиенту <b>{proxy_name}</b>.", parse_mode="HTML")
        except Exception as e:
            bot.send_message(message.chat.id, f"❌ Ошибка отправки: {e}")

        clear_state(uid)
        cmd_start(message)

    elif state == "WAIT_ADD_NAME":
        if not is_valid_proxy_name(text):
            return bot.send_message(message.chat.id, "❌ Ошибка: Имя должно содержать только латиницу, цифры и подчеркивания (от 3 до 32 символов).")

        tg_id = data.get("tg_id")
        proxy_name = text
        secret = secrets.token_hex(16)

        res = api_request("POST", "/users", {"username": proxy_name, "secret": secret, "max_tcp_conns": MAX_TCP_CONNS})

        if res and (res.get("ok") or res.get("error") == "conflict"):
            if res.get("error") == "conflict":
                api_res = api_request("GET", "/users")
                u_data = next((u for u in api_res.get("data", []) if u['username'] == proxy_name), {}) if api_res else {}
                secret = extract_secret_from_dict(u_data) or secret

            db_query("INSERT OR REPLACE INTO users VALUES (?, ?, ?)", (proxy_name, tg_id, secret))
            link = build_proxy_link(secret)

            markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
            markup.add("📊 Статистика", "📥 Заявки", "➕ Добавить", "📢 Рассылка", "⚫️ Черный список", "💾 Бэкап")

            bot.send_message(message.chat.id, f"✅ Успешно добавлен: <code>{proxy_name}</code>", parse_mode="HTML", reply_markup=markup)
            if link:
                bot.send_message(message.chat.id, link)

            if tg_id and link:
                try:
                    caption_text = f"🚀 Ваш прокси готов!{BAN_WARNING}"
                    bot.send_photo(tg_id, get_qr(link), caption=caption_text, parse_mode="HTML")
                    bot.send_message(tg_id, link)
                except: pass
        else:
            bot.send_message(message.chat.id, "❌ Возникла ошибка при добавлении пользователя в API.")

        clear_state(uid)

# =========================================================
# ПЕРЕСЫЛКА СООБЩЕНИЙ ОТ КЛИЕНТОВ АДМИНУ
# =========================================================

@bot.message_handler(
    func=lambda m: m.from_user.id not in ADMIN_IDS and get_state(m.from_user.id)[0] is None,
    content_types=['text', 'photo', 'document', 'video', 'audio', 'voice', 'sticker']
)
def forward_to_admin(message):
    uid = message.from_user.id

    if db_query("SELECT 1 FROM banned_users WHERE tg_id=?", (uid,), fetch=True):
        return

    now = int(time.time())

    user = get_user_by_tg_id(uid)
    proxy_name = user[0] if user else "Не зарегистрирован"

    markup = telebot.types.InlineKeyboardMarkup()
    markup.add(telebot.types.InlineKeyboardButton("🚫 Забанить TG", callback_data=f"bantg_{uid}"))

    for admin in ADMIN_IDS:
        try:
            fwd_msg = bot.forward_message(admin, message.chat.id, message.message_id)

            if fwd_msg.forward_from is None:
                db_query("INSERT OR REPLACE INTO reply_map VALUES (?, ?, ?)", (fwd_msg.message_id, uid, now))

            info_msg = bot.send_message(
                admin,
                f"🏷 Прокси: <code>{proxy_name}</code>\n<i>(Для ответа сделайте Reply на пересланное сообщение клиента)</i>",
                parse_mode="HTML",
                reply_markup=markup
            )
            db_query("INSERT OR REPLACE INTO reply_map VALUES (?, ?, ?)", (info_msg.message_id, uid, now))

        except Exception as e:
            logger.error(f"Ошибка пересылки сообщения админу {admin}: {e}")

# =========================================================
# ОТВЕТ АДМИНА КЛИЕНТУ
# =========================================================

@bot.message_handler(
    func=lambda m: m.from_user.id in ADMIN_IDS and m.reply_to_message is not None and get_state(m.from_user.id)[0] is None,
    content_types=['text', 'photo', 'document', 'video', 'audio', 'voice', 'sticker']
)
def admin_reply_to_user(message):
    reply_msg = message.reply_to_message
    target_uid = None

    if reply_msg.forward_from:
        target_uid = reply_msg.forward_from.id
    else:
        res = db_query("SELECT client_uid FROM reply_map WHERE admin_msg_id=?", (reply_msg.message_id,), fetch=True)
        if res:
            target_uid = res[0][0]

    if not target_uid:
        return bot.send_message(
            message.chat.id,
            "❌ Не удалось определить получателя. Возможно, сообщение слишком старое (старше 3 дней) или у клиента скрыт профиль."
        )

    try:
        bot.copy_message(target_uid, message.chat.id, message.message_id)
        bot.send_message(message.chat.id, "✅ Ответ отправлен!")
    except Exception as e:
        bot.send_message(message.chat.id, f"❌ Ошибка при отправке ответа: {e}")

# =========================================================
# MONITORING & RUN
# =========================================================

def ip_monitor_task():
    global api_offline_count
    while True:
        try:
            res = api_request("GET", "/users")
            if not res:
                api_offline_count += 1
                if api_offline_count == API_OFFLINE_THRESHOLD:
                    for a in ADMIN_IDS: bot.send_message(a, "🚨 <b>API OFFLINE!</b>", parse_mode="HTML")
            else:
                if api_offline_count >= API_OFFLINE_THRESHOLD:
                    for a in ADMIN_IDS: bot.send_message(a, "✅ <b>API ONLINE</b>", parse_mode="HTML")

                api_offline_count = 0
                now = int(time.time())

                for u in res.get("data", []):
                    name, ips = u.get("username"), u.get("active_unique_ips_list", []) or []
                    if len(ips) >= MAX_UNIQUE_IPS_ALERT:
                        for a in ADMIN_IDS: bot.send_message(a, f"⚠️ <b>ПОДОЗРЕНИЕ: {name}</b>\nIP: {len(ips)}", parse_mode="HTML")
                    for ip in ips: db_query("INSERT OR REPLACE INTO known_ips VALUES (?, ?, ?)", (name, ip, now))
                db_query("DELETE FROM known_ips WHERE last_seen < ?", (now - 7 * 86400,))
                db_query("DELETE FROM reply_map WHERE created_at < ?", (now - 3 * 86400,))

        except Exception as e: logger.error(f"Monitor: {e}")
        time.sleep(MONITOR_INTERVAL)

def run_bot():
    init_db(); sync_api_to_db()
    threading.Thread(target=ip_monitor_task, daemon=True).start()
    logger.info(f"Bot started | API: {API_URL} | Admins: {ADMIN_IDS} | Domain: {DOMAIN}")
    for admin in ADMIN_IDS:
        try:
            bot.send_message(admin, "🔄 <b>Панель перезапущена.</b> Бот снова в сети.", parse_mode="HTML")
        except Exception as e:
            logger.warning(f"Не удалось отправить уведомление о рестарте админу {admin}: {e}")
    while True:
        try: bot.polling(none_stop=True, timeout=60)
        except Exception as e: logger.error(f"Polling: {e}"); time.sleep(POLLING_RESTART_DELAY)

if __name__ == "__main__":
    run_bot()
