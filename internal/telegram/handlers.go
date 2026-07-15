package telegram

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

var proxyNameRe = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)
var replyProxyNameRe = regexp.MustCompile(`(?m)Прокси:\s*([a-zA-Z0-9_]{3,32})`)

func isValidProxyName(name string) bool {
	return proxyNameRe.MatchString(name)
}

// ── Update dispatcher ──────────────────────────────────────────────────────

func (b *Bot) handleUpdate(update tgbotapi.Update) {
	switch {
	case update.Message != nil:
		b.handleMessage(update.Message)
	case update.CallbackQuery != nil:
		b.handleCallback(update.CallbackQuery)
	}
}

func (b *Bot) handleMessage(msg *tgbotapi.Message) {
	if msg.From == nil {
		return
	}
	uid := msg.From.ID
	chatID := msg.Chat.ID

	// Detect and store language on first contact.
	if !b.dbHasLang(uid) {
		b.dbSetLang(uid, detectLang(msg.From.LanguageCode))
	}

	// FSM takes priority over everything else.
	if state := b.getState(uid); state != nil {
		b.handleFSM(msg, state)
		return
	}

	if msg.IsCommand() {
		switch msg.Command() {
		case "start", "cancel":
			b.cmdStart(msg)
		}
		return
	}

	text := msg.Text

	// ── Admin handlers ────────────────────────────────────────────────────
	if b.isAdmin(uid) {
		// Admin replying to a forwarded client message.
		if msg.ReplyToMessage != nil {
			b.adminReplyToUser(msg)
			return
		}
		switch text {
		case "📊 Статистика":
			b.adminStats(msg)
		case "📥 Заявки":
			b.adminRequests(msg)
		case "➕ Добавить":
			b.adminAdd(msg)
		case "📢 Рассылка":
			b.adminBroadcastStart(msg)
		case "⚫️ Черный список":
			b.adminBlacklist(msg)
		case "💾 Бэкап":
			b.adminBackup(msg)
		case "⚙️ Сервис":
			b.adminService(msg)
		}
		return
	}

	// ── Client handlers ───────────────────────────────────────────────────
	switch {
	case isButton(text, "btn_register"):
		b.userRegister(msg)
	case isButton(text, "btn_stats"):
		b.userStats(msg)
	case isButton(text, "btn_link"):
		b.userLink(msg)
	default:
		// Any other message from a registered client → forward to admins.
		if !b.dbIsBanned(uid) {
			b.forwardToAdmin(msg)
		} else {
			b.send(chatID, b.t(uid, "banned"))
		}
	}
}

// ── /start ─────────────────────────────────────────────────────────────────

func (b *Bot) cmdStart(msg *tgbotapi.Message) {
	uid := msg.From.ID
	b.clearState(uid)

	if b.isAdmin(uid) {
		dashboard := b.syncAndDashboard()
		b.sendMarkup(msg.Chat.ID, dashboard, b.adminKeyboard())
		return
	}

	if b.dbIsBanned(uid) {
		b.send(msg.Chat.ID, b.t(uid, "banned"))
		return
	}

	proxyName, _ := b.dbGetUser(uid)
	if proxyName != "" {
		b.sendMarkup(msg.Chat.ID, b.t(uid, "welcome_user"), b.userKeyboard(uid))
		return
	}

	if b.dbHasRequest(uid) {
		b.send(msg.Chat.ID, b.t(uid, "req_pending"))
		return
	}

	// New user — show register button.
	kb := tgbotapi.NewReplyKeyboard(tgbotapi.NewKeyboardButtonRow(
		tgbotapi.NewKeyboardButton(b.t(uid, "btn_register")),
	))
	kb.ResizeKeyboard = true
	b.sendMarkup(msg.Chat.ID, b.t(uid, "welcome_new"), kb)
}

// ── Client handlers ────────────────────────────────────────────────────────

func (b *Bot) userRegister(msg *tgbotapi.Message) {
	uid := msg.From.ID
	if b.isAdmin(uid) {
		return
	}
	proxyName, _ := b.dbGetUser(uid)
	if proxyName != "" {
		return
	}
	if b.dbIsBanned(uid) {
		b.send(msg.Chat.ID, b.t(uid, "req_access_denied"))
		return
	}
	if b.dbHasRequest(uid) {
		b.send(msg.Chat.ID, b.t(uid, "req_already_pending"))
		return
	}

	username := msg.From.UserName
	desiredName := cleanUsername(username, uid)

	// Sync API users to ensure name uniqueness.
	if users, err := b.apiGetUsers(); err == nil {
		b.dbSyncUsers(users)
	}
	if b.dbNameTaken(desiredName) {
		desiredName = fmt.Sprintf("%s_%s", desiredName, strconv.FormatInt(uid, 10)[len(strconv.FormatInt(uid, 10))-4:])
		if len(desiredName) > 32 {
			desiredName = desiredName[:32]
		}
	}

	b.dbAddRequest(uid, orDefault(username, "Без_юзернейма"), desiredName)
	b.sendMarkup(msg.Chat.ID, b.t(uid, "req_sent"), tgbotapi.NewRemoveKeyboard(true))

	// Notify admins.
	b.mu.Lock()
	adminIDs := make([]int64, len(b.cfg.Telegram.AdminIDs))
	copy(adminIDs, b.cfg.Telegram.AdminIDs)
	b.mu.Unlock()

	for _, adminID := range adminIDs {
		kb := tgbotapi.NewInlineKeyboardMarkup(tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("✅ Одобрить", fmt.Sprintf("req_y_%d", uid)),
			tgbotapi.NewInlineKeyboardButtonData("❌ Отклонить", fmt.Sprintf("req_n_%d", uid)),
		))
		b.sendMarkup(adminID,
			fmt.Sprintf("🔔 Новая заявка\n👤 @%s (ID: %d)\n🏷 Имя: %s",
				orDefault(username, "Без_юзернейма"), uid, desiredName),
			kb,
		)
	}
}

func (b *Bot) userStats(msg *tgbotapi.Message) {
	uid := msg.From.ID
	proxyName, _ := b.dbGetUser(uid)
	if proxyName == "" {
		return
	}
	users, err := b.apiGetUsers()
	if err != nil {
		b.send(msg.Chat.ID, b.t(uid, "api_unavailable"))
		return
	}
	for _, u := range users {
		if u.name == proxyName {
			ips := strings.Join(u.activeIPs, ", ")
			if ips == "" {
				ips = b.t(uid, "ip_none")
			}
			b.send(msg.Chat.ID, fmt.Sprintf(b.t(uid, "user_stats"), proxyName, formatTraffic(u.totalOctets), ips))
			return
		}
	}
	b.send(msg.Chat.ID, b.t(uid, "data_not_found"))
}

func (b *Bot) userLink(msg *tgbotapi.Message) {
	uid := msg.From.ID
	_, secret := b.dbGetUser(uid)
	if secret == "" {
		return
	}
	link := b.buildProxyLink(secret)
	if link == "" {
		b.send(msg.Chat.ID, b.t(uid, "link_error"))
		return
	}
	caption := b.t(uid, "link_caption") + b.t(uid, "ban_warning")
	b.sendQR(msg.Chat.ID, link, caption)
	b.send(msg.Chat.ID, link)
}

// ── Admin handlers ─────────────────────────────────────────────────────────

func (b *Bot) adminStats(msg *tgbotapi.Message) {
	users, err := b.apiGetUsers()
	if err != nil {
		b.send(msg.Chat.ID, "❌ API недоступно.")
		return
	}
	b.dbSyncUsers(users)

	var activeCount int
	rows := []tgbotapi.InlineKeyboardButton{}
	for _, u := range users {
		if len(u.activeIPs) > 0 {
			activeCount++
			rows = append(rows, tgbotapi.NewInlineKeyboardButtonData("🟢 "+u.name, "st_"+u.name))
		}
	}

	var kbRows [][]tgbotapi.InlineKeyboardButton
	for _, btn := range rows {
		kbRows = append(kbRows, []tgbotapi.InlineKeyboardButton{btn})
	}
	kbRows = append(kbRows, []tgbotapi.InlineKeyboardButton{
		tgbotapi.NewInlineKeyboardButtonData("Показать всех клиентов", "st_all"),
	})
	kb := tgbotapi.NewInlineKeyboardMarkup(kbRows...)

	var text string
	if activeCount > 0 {
		text = fmt.Sprintf("Выберите клиента:\n<i>(Активных онлайн: %d)</i>", activeCount)
	} else {
		text = "Активных клиентов сейчас нет."
	}
	b.sendMarkup(msg.Chat.ID, text, kb)
}

func (b *Bot) adminRequests(msg *tgbotapi.Message) {
	reqs := b.dbGetRequests()
	if len(reqs) == 0 {
		b.send(msg.Chat.ID, "📭 Очередь пуста.")
		return
	}
	for _, r := range reqs {
		kb := tgbotapi.NewInlineKeyboardMarkup(tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("✅ Одобрить", fmt.Sprintf("req_y_%d", r.tgID)),
			tgbotapi.NewInlineKeyboardButtonData("❌ Отклонить", fmt.Sprintf("req_n_%d", r.tgID)),
		))
		b.sendMarkup(msg.Chat.ID,
			fmt.Sprintf("👤 @%s (ID: <code>%d</code>)\n🏷 Имя прокси: <code>%s</code>",
				r.tgUsername, r.tgID, r.desiredName),
			kb,
		)
	}
}

func (b *Bot) adminAdd(msg *tgbotapi.Message) {
	b.setState(msg.From.ID, "WAIT_ADD_NAME", nil)
	b.sendMarkup(msg.Chat.ID, "Введите <b>имя прокси</b> для нового пользователя\n(только a-z, 0-9, _ — от 3 до 32 символов):", b.cancelKeyboard())
}

func (b *Bot) adminBroadcastStart(msg *tgbotapi.Message) {
	b.setState(msg.From.ID, "WAIT_BROADCAST", nil)
	b.sendMarkup(msg.Chat.ID, "Введите текст рассылки:", b.cancelKeyboard())
}

func (b *Bot) adminBlacklist(msg *tgbotapi.Message) {
	banned := b.dbGetBanned()
	if len(banned) == 0 {
		b.send(msg.Chat.ID, "⚫️ Список пуст.")
		return
	}
	for _, r := range banned {
		kb := tgbotapi.NewInlineKeyboardMarkup(tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("🔄 Разбанить", fmt.Sprintf("unban_%d", r.tgID)),
		))
		b.sendMarkup(msg.Chat.ID,
			fmt.Sprintf("👤 ID: <code>%d</code>\n🏷 Имя: <code>%s</code>\n📝 Причина: %s",
				r.tgID, r.proxyName, r.reason),
			kb,
		)
	}
}

func (b *Bot) adminBackup(msg *tgbotapi.Message) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	tmpPath := filepath.Join(b.cfg.DataDir, "bot", "users_backup_tmp.db")
	defer os.Remove(tmpPath)
	if _, err := db.Exec("VACUUM INTO ?", tmpPath); err != nil {
		b.send(msg.Chat.ID, fmt.Sprintf("❌ Ошибка резервной копии: %v", err))
		return
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		b.send(msg.Chat.ID, fmt.Sprintf("❌ Ошибка чтения: %v", err))
		return
	}
	b.sendDocument(msg.Chat.ID, "users.db", data, "💾 Резервная копия БД")
}

func (b *Bot) adminService(msg *tgbotapi.Message) {
	kb := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("🔄 Перезапустить бота", "svc_ask_bot"),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("🔄 Перезапустить Telemt", "svc_ask_telemt"),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("🔄 Перезапустить панель", "svc_ask_panel"),
		),
	)
	b.sendMarkup(msg.Chat.ID, "⚙️ Сервисные действия:", kb)
}

func (b *Bot) adminReplyToUser(msg *tgbotapi.Message) {
	reply := msg.ReplyToMessage
	var targetUID int64
	if reply.ForwardFrom != nil {
		targetUID = reply.ForwardFrom.ID
	} else {
		targetUID = b.dbGetReplyTarget(reply.MessageID)
	}
	if targetUID == 0 {
		targetUID = b.dbGetNearbyReplyTarget(reply.MessageID)
	}
	if targetUID == 0 {
		if proxyName := replyProxyName(reply); proxyName != "" {
			targetUID, _ = b.dbGetUserByName(proxyName)
		}
	}
	if targetUID == 0 {
		log.Printf("[telegram] reply target miss: admin_id=%d reply_to_msg_id=%d msg_id=%d", msg.From.ID, reply.MessageID, msg.MessageID)
		b.send(msg.Chat.ID, "❌ Не удалось определить получателя. Возможно, сообщение слишком старое (старше 3 дней).")
		return
	}
	b.copyMsg(targetUID, msg.Chat.ID, msg.MessageID)
	b.send(msg.Chat.ID, "✅ Ответ отправлен!")
}

// ── FSM ────────────────────────────────────────────────────────────────────

func (b *Bot) handleFSM(msg *tgbotapi.Message, state *fsmState) {
	uid := msg.From.ID
	text := strings.TrimSpace(msg.Text)

	if isCancel(text) {
		b.clearState(uid)
		b.send(msg.Chat.ID, b.t(uid, "action_cancelled"))
		b.cmdStart(msg)
		return
	}

	switch state.State {
	case "WAIT_BROADCAST":
		b.fsmBroadcast(msg, text)
	case "WAIT_ADD_NAME":
		b.fsmAddName(msg, text)
	case "WAIT_ADD_TGID":
		b.fsmAddTGID(msg, text, state)
	case "WAIT_TG_BIND":
		b.fsmBindTGID(msg, text, state)
	case "WAIT_MSG_TO_USER":
		b.fsmMsgToUser(msg, state)
	}
}

func (b *Bot) fsmBroadcast(msg *tgbotapi.Message, text string) {
	uid := msg.From.ID
	tgIDs := b.dbGetAllUserTGIDs()
	b.send(msg.Chat.ID, fmt.Sprintf("⏳ Рассылка для %d чел...", len(tgIDs)))
	prefix := b.t(uid, "broadcast_prefix")
	for _, id := range tgIDs {
		b.send(id, b.t(id, "broadcast_prefix")+text)
		_ = prefix
		time.Sleep(50 * time.Millisecond)
	}
	b.clearState(uid)
	b.cmdStart(msg)
}

func (b *Bot) fsmAddName(msg *tgbotapi.Message, text string) {
	uid := msg.From.ID
	if !isValidProxyName(text) {
		b.send(msg.Chat.ID, "❌ Имя должно содержать только латиницу, цифры и _ (3-32 символа).")
		return
	}
	b.setState(uid, "WAIT_ADD_TGID", map[string]string{"proxy_name": text})
	b.sendMarkup(msg.Chat.ID, fmt.Sprintf("✅ Имя прокси: <code>%s</code>\n\nВведите <b>Telegram ID</b>, отправьте контакт пользователя или отправьте «нет» чтобы пропустить:", text), b.contactKeyboard())
}

func (b *Bot) fsmAddTGID(msg *tgbotapi.Message, text string, state *fsmState) {
	uid := msg.From.ID
	proxyName := state.Data["proxy_name"]

	var tgID int64
	if msg.Contact != nil {
		tgID = msg.Contact.UserID
		if tgID == 0 {
			b.send(msg.Chat.ID, "❌ В этом контакте нет Telegram ID. Введите ID вручную или отправьте «нет».")
			return
		}
	} else if text != "нет" && text != "no" && text != "skip" {
		parsed, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			b.send(msg.Chat.ID, "❌ Введите числовой Telegram ID, отправьте контакт или «нет».")
			return
		}
		tgID = parsed
	}

	secret := randomHex(16)
	ok, realSecret, _ := b.apiCreateUser(proxyName, secret)
	if !ok {
		b.send(msg.Chat.ID, "❌ Ошибка API при добавлении пользователя.")
		b.clearState(uid)
		return
	}

	b.dbAddUser(proxyName, tgID, realSecret)
	b.clearState(uid)

	link := b.buildProxyLink(realSecret)
	b.sendMarkup(msg.Chat.ID, fmt.Sprintf("✅ Добавлен: <code>%s</code>", proxyName), b.adminKeyboard())
	if link != "" {
		b.send(msg.Chat.ID, link)
	}

	if tgID != 0 && link != "" {
		caption := b.t(tgID, "proxy_ready") + b.t(tgID, "ban_warning")
		b.sendQR(tgID, link, caption)
		b.send(tgID, link)
	}
}

func (b *Bot) fsmBindTGID(msg *tgbotapi.Message, text string, state *fsmState) {
	uid := msg.From.ID
	proxyName := state.Data["proxy_name"]

	var tgID int64
	if msg.Contact != nil {
		tgID = msg.Contact.UserID
		if tgID == 0 {
			b.send(msg.Chat.ID, "❌ В этом контакте нет Telegram ID. Введите ID вручную.")
			return
		}
	} else {
		parsed, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			b.send(msg.Chat.ID, "❌ Введите корректный числовой Telegram ID или отправьте контакт.")
			return
		}
		tgID = parsed
	}
	b.dbUpdateUserTGID(proxyName, tgID)
	b.clearState(uid)
	b.sendMarkup(msg.Chat.ID,
		fmt.Sprintf("✅ Пользователь <b>%s</b> привязан к TG ID <code>%d</code>.", proxyName, tgID),
		b.adminKeyboard(),
	)
}

func (b *Bot) fsmMsgToUser(msg *tgbotapi.Message, state *fsmState) {
	uid := msg.From.ID
	tgID, _ := strconv.ParseInt(state.Data["tg_id"], 10, 64)
	proxyName := state.Data["proxy_name"]

	b.copyMsg(tgID, msg.Chat.ID, msg.MessageID)
	b.clearState(uid)
	b.send(msg.Chat.ID, fmt.Sprintf("✅ Сообщение отправлено клиенту <b>%s</b>.", proxyName))
	b.cmdStart(msg)
}

// ── Callbacks ──────────────────────────────────────────────────────────────

func (b *Bot) handleCallback(cq *tgbotapi.CallbackQuery) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	if cq.Message == nil {
		api.Request(tgbotapi.NewCallback(cq.ID, "")) //nolint:errcheck
		return
	}
	api.Request(tgbotapi.NewCallback(cq.ID, "")) //nolint:errcheck

	data := cq.Data
	chatID := cq.Message.Chat.ID
	msgID := cq.Message.MessageID

	switch {
	case strings.HasPrefix(data, "req_y_") || strings.HasPrefix(data, "req_n_"):
		b.cbProcessRequest(cq)
	case strings.HasPrefix(data, "st_"):
		b.cbShowStats(cq)
	case strings.HasPrefix(data, "ban_ask_") || strings.HasPrefix(data, "del_ask_"):
		b.cbConfirmAsk(cq)
	case strings.HasPrefix(data, "ban_yes_") || strings.HasPrefix(data, "del_yes_"):
		b.cbConfirmExec(cq)
	case strings.HasPrefix(data, "bind_ask_"):
		b.cbBindAsk(cq)
	case strings.HasPrefix(data, "msg_ask_"):
		b.cbMsgAsk(cq)
	case strings.HasPrefix(data, "tgid_"):
		b.cbShowTGID(cq)
	case strings.HasPrefix(data, "qr_"):
		b.cbShowQR(cq)
	case strings.HasPrefix(data, "reply_"):
		b.cbReplyAsk(cq)
	case strings.HasPrefix(data, "rotate_ask_"):
		b.cbRotateAsk(cq)
	case strings.HasPrefix(data, "rotate_yes_"):
		b.cbRotateExec(cq)
	case strings.HasPrefix(data, "bantg_"):
		b.cbBanTG(cq)
	case strings.HasPrefix(data, "unban_"):
		b.cbUnban(cq)
	case strings.HasPrefix(data, "svc_ask_"):
		b.cbServiceAsk(cq)
	case strings.HasPrefix(data, "svc_yes_"):
		b.cbServiceExec(cq)
	case data == "cancel_action":
		b.editText(chatID, msgID, "Действие отменено.", nil)
	}
}

func (b *Bot) cbProcessRequest(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	data := cq.Data
	action := data[4:5] // "y" or "n"
	tgID, err := strconv.ParseInt(data[6:], 10, 64)
	if err != nil {
		return
	}
	chatID := cq.Message.Chat.ID
	msgID := cq.Message.MessageID

	proxyName, username, ok := b.dbGetRequest(tgID)
	if !ok {
		b.editText(chatID, msgID, "⚠️ Обработано.", nil)
		return
	}

	if action == "n" {
		b.dbDeleteRequest(tgID)
		b.editText(chatID, msgID, fmt.Sprintf("❌ Заявка от @%s отклонена.", username), nil)
		b.send(tgID, b.t(tgID, "req_rejected"))
		return
	}

	// Approve.
	secret := randomHex(16)
	ok2, realSecret, _ := b.apiCreateUser(proxyName, secret)
	if !ok2 {
		b.send(chatID, "❌ Ошибка API при одобрении.")
		return
	}

	if err := b.dbApproveRequest(proxyName, tgID, realSecret); err != nil {
		b.send(chatID, fmt.Sprintf("❌ Ошибка БД при одобрении: %v", err))
		return
	}

	b.editText(chatID, msgID, fmt.Sprintf("✅ Одобрено: <code>%s</code>", proxyName), nil)
	b.sendMarkup(tgID, b.t(tgID, "req_approved"), b.userKeyboard(tgID))

	link := b.buildProxyLink(realSecret)
	if link != "" {
		caption := b.t(tgID, "link_caption") + b.t(tgID, "ban_warning")
		b.sendQR(tgID, link, caption)
		b.send(tgID, link)
	}
}

func (b *Bot) cbShowStats(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	chatID := cq.Message.Chat.ID
	msgID := cq.Message.MessageID

	if cq.Data == "st_all" {
		users, err := b.apiGetUsers()
		if err != nil {
			b.editText(chatID, msgID, "❌ API недоступно.", nil)
			return
		}
		var kbRows [][]tgbotapi.InlineKeyboardButton
		for _, u := range users {
			icon := "⚪️"
			if len(u.activeIPs) > 0 {
				icon = "🟢"
			}
			kbRows = append(kbRows, []tgbotapi.InlineKeyboardButton{
				tgbotapi.NewInlineKeyboardButtonData(icon+" "+u.name, "st_"+u.name),
			})
		}
		kb := tgbotapi.NewInlineKeyboardMarkup(kbRows...)
		b.editText(chatID, msgID, "Все клиенты:\n<i>(🟢 Онлайн / ⚪️ Офлайн)</i>", &kb)
		return
	}

	// Show single user.
	name := cq.Data[3:]
	users, err := b.apiGetUsers()
	if err != nil {
		b.send(chatID, "Ошибка API.")
		return
	}
	for _, u := range users {
		if u.name != name {
			continue
		}
		ips := strings.Join(u.activeIPs, ", ")
		if ips == "" {
			ips = "нет"
		}
		text := fmt.Sprintf("👤 <code>%s</code>\n📊 Трафик: <code>%s</code>\n📍 IP: <code>%s</code>",
			name, formatTraffic(u.totalOctets), ips)
		kb := tgbotapi.NewInlineKeyboardMarkup(
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("🚫 Забанить", "ban_ask_"+name),
				tgbotapi.NewInlineKeyboardButtonData("❌ Удалить", "del_ask_"+name),
			),
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("🔗 Привязать TG", "bind_ask_"+name),
				tgbotapi.NewInlineKeyboardButtonData("✉️ Написать", "msg_ask_"+name),
			),
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("🆔 Показать TG ID", "tgid_"+name),
				tgbotapi.NewInlineKeyboardButtonData("📱 Показать QR", "qr_"+name),
			),
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("🔁 Перевыпустить ссылку", "rotate_ask_"+name),
			),
		)
		b.editText(chatID, msgID, text, &kb)
		return
	}
	b.send(chatID, fmt.Sprintf("Данные по %s не найдены.", name))
}

func (b *Bot) cbConfirmAsk(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	isBan := strings.HasPrefix(cq.Data, "ban_ask_")
	name := cq.Data[8:]
	action := "УДАЛИТЬ"
	cbData := "del_yes_" + name
	if isBan {
		action = "ЗАБАНИТЬ"
		cbData = "ban_yes_" + name
	}
	kb := tgbotapi.NewInlineKeyboardMarkup(tgbotapi.NewInlineKeyboardRow(
		tgbotapi.NewInlineKeyboardButtonData("🚨 ДА, "+action, cbData),
		tgbotapi.NewInlineKeyboardButtonData("Отмена", "cancel_action"),
	))
	b.editText(cq.Message.Chat.ID, cq.Message.MessageID,
		fmt.Sprintf("⚠️ Точно %s <code>%s</code>?", strings.ToLower(action), name), &kb)
}

func (b *Bot) cbConfirmExec(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	api := b.rawAPI()
	if api != nil {
		api.Request(tgbotapi.NewCallback(cq.ID, "Выполняю...")) //nolint:errcheck
	}

	isBan := strings.HasPrefix(cq.Data, "ban_yes_")
	name := cq.Data[8:]

	if err := b.apiDeleteUser(name); err != nil {
		b.editText(cq.Message.Chat.ID, cq.Message.MessageID,
			fmt.Sprintf("❌ Ошибка API: прокси <code>%s</code> не удалён. Повторите позже.\n%v", name, err), nil)
		return
	}

	if isBan {
		tgID, _ := b.dbGetUserByName(name)
		if tgID != 0 {
			b.dbBanUser(tgID, name, "Ручная блокировка")
			b.send(tgID, b.t(tgID, "access_blocked"))
		}
	}

	b.dbCleanUser(name)
	b.editText(cq.Message.Chat.ID, cq.Message.MessageID, fmt.Sprintf("✅ Исполнено: <code>%s</code>", name), nil)
}

func (b *Bot) cbBindAsk(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	proxyName := cq.Data[9:]
	b.setState(cq.From.ID, "WAIT_TG_BIND", map[string]string{"proxy_name": proxyName})
	b.sendMarkup(cq.Message.Chat.ID,
		fmt.Sprintf("Введите <b>Telegram ID</b> пользователя или отправьте контакт для прокси <code>%s</code>:", proxyName),
		b.contactKeyboard(),
	)
}

func (b *Bot) cbMsgAsk(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	name := cq.Data[8:]
	tgID, _ := b.dbGetUserByName(name)
	if tgID == 0 {
		b.send(cq.Message.Chat.ID, fmt.Sprintf("❌ У пользователя <b>%s</b> не привязан Telegram.", name))
		return
	}
	b.setState(cq.From.ID, "WAIT_MSG_TO_USER", map[string]string{
		"tg_id":      strconv.FormatInt(tgID, 10),
		"proxy_name": name,
	})
	b.sendMarkup(cq.Message.Chat.ID,
		fmt.Sprintf("Напишите сообщение для <b>%s</b> (можно прикрепить фото/файл):", name),
		b.cancelKeyboard(),
	)
}

func (b *Bot) cbShowTGID(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	name := cq.Data[5:]
	tgID, _ := b.dbGetUserByName(name)
	if tgID == 0 {
		b.send(cq.Message.Chat.ID, fmt.Sprintf("⚠️ Пользователь <b>%s</b> не привязан к Telegram.", name))
		return
	}
	kb := tgbotapi.NewInlineKeyboardMarkup(tgbotapi.NewInlineKeyboardRow(
		tgbotapi.NewInlineKeyboardButtonURL("Открыть профиль", fmt.Sprintf("tg://user?id=%d", tgID)),
	))
	b.sendMarkup(cq.Message.Chat.ID,
		fmt.Sprintf("👤 Пользователь: <b>%s</b>\nID Telegram: <code>%d</code>", name, tgID),
		kb,
	)
}

func (b *Bot) cbShowQR(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	name := cq.Data[3:]
	_, secret := b.dbGetUserByName(name)
	if secret == "" {
		b.send(cq.Message.Chat.ID, "❌ У этого пользователя нет секрета.")
		return
	}
	link := b.buildProxyLink(secret)
	if link == "" {
		b.send(cq.Message.Chat.ID, "❌ PROXY_DOMAIN не настроен.")
		return
	}
	b.sendQR(cq.Message.Chat.ID, link, fmt.Sprintf("🚀 QR и ссылка для <b>%s</b>:\n\n<code>%s</code>", name, link))
}

func (b *Bot) cbReplyAsk(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	tgID, err := strconv.ParseInt(cq.Data[6:], 10, 64)
	if err != nil {
		return
	}
	proxyName, _ := b.dbGetUser(tgID)
	if proxyName == "" {
		proxyName = strconv.FormatInt(tgID, 10)
	}
	b.setState(cq.From.ID, "WAIT_MSG_TO_USER", map[string]string{
		"tg_id":      strconv.FormatInt(tgID, 10),
		"proxy_name": proxyName,
	})
	b.sendMarkup(cq.Message.Chat.ID, fmt.Sprintf("Напишите ответ для <b>%s</b>:", proxyName), b.cancelKeyboard())
}

func (b *Bot) cbRotateAsk(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	name := cq.Data[11:]
	kb := tgbotapi.NewInlineKeyboardMarkup(tgbotapi.NewInlineKeyboardRow(
		tgbotapi.NewInlineKeyboardButtonData("🚨 ДА, перевыпустить", "rotate_yes_"+name),
		tgbotapi.NewInlineKeyboardButtonData("Отмена", "cancel_action"),
	))
	b.editText(cq.Message.Chat.ID, cq.Message.MessageID,
		fmt.Sprintf("⚠️ Перевыпустить ссылку для <code>%s</code>?\nСтарая ссылка перестанет работать.", name), &kb)
}

func (b *Bot) cbRotateExec(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	name := cq.Data[11:]
	tgID, oldSecret := b.dbGetUserByName(name)
	secret := randomHex(16)
	realSecret, err := b.apiRotateUserSecret(name, oldSecret, secret)
	if err != nil {
		b.editText(cq.Message.Chat.ID, cq.Message.MessageID,
			fmt.Sprintf("❌ Не удалось перевыпустить ссылку для <code>%s</code>: %v", name, err), nil)
		return
	}
	b.dbUpdateUserSecret(name, realSecret)
	link := b.buildProxyLink(realSecret)
	if link == "" {
		b.editText(cq.Message.Chat.ID, cq.Message.MessageID,
			fmt.Sprintf("✅ Секрет для <code>%s</code> обновлён, но домен прокси не настроен.", name), nil)
		return
	}
	b.editText(cq.Message.Chat.ID, cq.Message.MessageID, fmt.Sprintf("✅ Ссылка для <code>%s</code> перевыпущена.", name), nil)
	b.sendQR(cq.Message.Chat.ID, link, fmt.Sprintf("🚀 Новая ссылка для <b>%s</b>:\n\n<code>%s</code>", name, link))
	b.send(cq.Message.Chat.ID, link)
	if tgID != 0 {
		caption := b.t(tgID, "link_caption") + b.t(tgID, "ban_warning")
		b.sendQR(tgID, link, caption)
		b.send(tgID, link)
	}
}

func (b *Bot) cbBanTG(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	api := b.rawAPI()
	if api != nil {
		api.Request(tgbotapi.NewCallback(cq.ID, "Блокируем...")) //nolint:errcheck
	}

	tgID, _ := strconv.ParseInt(cq.Data[6:], 10, 64)
	proxyName, _ := b.dbGetUser(tgID)
	if proxyName == "" {
		proxyName = "Спамер (без прокси)"
	}

	b.dbBanUser(tgID, proxyName, "Бан за спам")

	if proxyName != "Спамер (без прокси)" {
		if err := b.apiDeleteUser(proxyName); err != nil {
			b.editText(cq.Message.Chat.ID, cq.Message.MessageID,
				fmt.Sprintf("🏷 Прокси: <code>%s</code>\n\n⚠️ <b>TG ID %d забанен в БД</b>, но ошибка API: %v\nУдалите прокси вручную.", proxyName, tgID, err),
				nil,
			)
			return
		}
		b.dbCleanUser(proxyName)
		b.send(tgID, b.t(tgID, "access_blocked"))
	}

	b.editText(cq.Message.Chat.ID, cq.Message.MessageID,
		fmt.Sprintf("🏷 Прокси: <code>%s</code>\n<i>(Для ответа сделайте Reply на пересланное сообщение)</i>\n\n✅ <b>TG ID %d ЗАБЛОКИРОВАН</b>",
			proxyName, tgID),
		nil,
	)
}

func (b *Bot) cbUnban(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	tgID, err := strconv.ParseInt(cq.Data[6:], 10, 64)
	if err != nil {
		return
	}
	if !b.dbIsBanned(tgID) {
		b.editText(cq.Message.Chat.ID, cq.Message.MessageID, "Пользователь уже разбанен.", nil)
		return
	}
	b.dbUnbanUser(tgID)
	b.editText(cq.Message.Chat.ID, cq.Message.MessageID, "✅ Пользователь разбанен.", nil)
}

func (b *Bot) cbServiceAsk(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	target := cq.Data[8:]
	label := map[string]string{
		"bot":    "бота",
		"telemt": "Telemt",
		"panel":  "панель",
	}[target]
	if label == "" {
		return
	}
	kb := tgbotapi.NewInlineKeyboardMarkup(tgbotapi.NewInlineKeyboardRow(
		tgbotapi.NewInlineKeyboardButtonData("🚨 ДА, перезапустить", "svc_yes_"+target),
		tgbotapi.NewInlineKeyboardButtonData("Отмена", "cancel_action"),
	))
	b.editText(cq.Message.Chat.ID, cq.Message.MessageID, fmt.Sprintf("⚠️ Перезапустить %s?", label), &kb)
}

func (b *Bot) cbServiceExec(cq *tgbotapi.CallbackQuery) {
	if !b.isAdmin(cq.From.ID) {
		return
	}
	target := cq.Data[8:]
	chatID := cq.Message.Chat.ID
	msgID := cq.Message.MessageID
	switch target {
	case "bot":
		b.editText(chatID, msgID, "⏳ Перезапускаю бота...", nil)
		b.restartBotAsync(chatID)
	case "telemt":
		b.runServiceAction(chatID, msgID, "Telemt", func(actions ServiceActions) func() error {
			return actions.RestartTelemt
		})
	case "panel":
		b.runServiceAction(chatID, msgID, "панель", func(actions ServiceActions) func() error {
			return actions.RestartPanel
		})
	}
}

func (b *Bot) restartBotAsync(chatID int64) {
	go func() {
		time.Sleep(300 * time.Millisecond)
		b.Stop()
		if err := b.Start(); err != nil {
			log.Printf("[telegram] bot restart failed: %v", err)
			return
		}
		b.send(chatID, "✅ Бот перезапущен.")
	}()
}

func (b *Bot) runServiceAction(chatID int64, msgID int, label string, pick func(ServiceActions) func() error) {
	b.mu.Lock()
	action := pick(b.actions)
	b.mu.Unlock()
	if action == nil {
		b.editText(chatID, msgID, fmt.Sprintf("❌ Рестарт %s не настроен.", label), nil)
		return
	}
	b.editText(chatID, msgID, fmt.Sprintf("⏳ Перезапускаю %s...", label), nil)
	go func() {
		if err := action(); err != nil {
			b.send(chatID, fmt.Sprintf("❌ Не удалось перезапустить %s: %v", label, err))
			return
		}
		b.send(chatID, fmt.Sprintf("✅ Рестарт %s запущен.", label))
	}()
}

// ── Forward client messages to admins ─────────────────────────────────────

func (b *Bot) forwardToAdmin(msg *tgbotapi.Message) {
	api := b.rawAPI()
	if api == nil {
		return
	}

	uid := msg.From.ID
	proxyName, _ := b.dbGetUser(uid)
	if proxyName == "" {
		proxyName = "Не зарегистрирован"
	}

	adminActions := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("✉️ Ответить", fmt.Sprintf("reply_%d", uid)),
			tgbotapi.NewInlineKeyboardButtonData("🚫 Забанить TG", fmt.Sprintf("bantg_%d", uid)),
		),
	)

	b.mu.Lock()
	adminIDs := make([]int64, len(b.cfg.Telegram.AdminIDs))
	copy(adminIDs, b.cfg.Telegram.AdminIDs)
	b.mu.Unlock()

	for _, adminID := range adminIDs {
		fwdCfg := tgbotapi.NewForward(adminID, msg.Chat.ID, msg.MessageID)
		fwdMsg, err := api.Send(fwdCfg)
		if err == nil {
			b.dbSaveReplyMap(fwdMsg.MessageID, uid)
		}

		infoText := fmt.Sprintf("🏷 Прокси: <code>%s</code>\n<i>(Reply на пересланное сообщение для ответа)</i>", proxyName)
		infoMsg := tgbotapi.NewMessage(adminID, infoText)
		infoMsg.ParseMode = tgbotapi.ModeHTML
		infoMsg.ReplyMarkup = adminActions
		sent, err := api.Send(infoMsg)
		if err == nil {
			b.dbSaveReplyMap(sent.MessageID, uid)
		}
		if err != nil {
			log.Printf("[telegram] forward to admin %d failed: %v", adminID, err)
		}
	}
}

// ── Utilities ──────────────────────────────────────────────────────────────

func cleanUsername(username string, uid int64) string {
	name := regexp.MustCompile(`[^a-zA-Z0-9_]`).ReplaceAllString(username, "")
	if len(name) > 32 {
		name = name[:32]
	}
	if len(name) < 3 {
		name = fmt.Sprintf("user_%d", uid)
		if len(name) > 32 {
			name = name[:32]
		}
	}
	return name
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func replyProxyName(msg *tgbotapi.Message) string {
	if msg == nil {
		return ""
	}
	text := msg.Text
	if text == "" {
		text = msg.Caption
	}
	m := replyProxyNameRe.FindStringSubmatch(text)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}
