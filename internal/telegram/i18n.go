package telegram

import "strings"

var i18nStrings = map[string]map[string]string{
	"ru": {
		"btn_register":        "📝 Регистрация",
		"btn_stats":           "📊 Моя статистика",
		"btn_link":            "🔗 Моя ссылка",
		"welcome_user":        "👋 Добро пожаловать!\nИспользуйте меню ниже.",
		"welcome_new":         "👋 Добро пожаловать!\nДля получения доступа к прокси подайте заявку.",
		"banned":              "🚫 Вам отказано в доступе. Ваш аккаунт заблокирован.",
		"req_pending":         "⏳ Ваша заявка находится на рассмотрении. Ожидайте решения администратора.",
		"req_already_pending": "⏳ Ваша заявка уже на рассмотрении.",
		"req_access_denied":   "🚫 Доступ запрещен. Аккаунт заблокирован.",
		"req_sent":            "✅ Заявка отправлена!",
		"api_unavailable":     "❌ Сервер временно недоступен.",
		"data_not_found":      "❌ Данные не найдены.",
		"ip_none":             "нет",
		"link_error":          "❌ Ошибка генерации ссылки.",
		"link_caption":        "🚀 Ваша ссылка для подключения:",
		"req_approved":        "🎉 Ваша заявка одобрена! Вам доступно меню.",
		"req_rejected":        "❌ Ваша заявка отклонена.",
		"access_blocked":      "🚫 Ваш доступ заблокирован.",
		"proxy_ready":         "🚀 Ваш прокси готов!",
		"ban_warning":         "\n\n⚠️ <b>ВАЖНО:</b> Ссылка персональная. Запрещено передавать её другим людям. При нарушении доступ блокируется.",
		"action_cancelled":    "❌ Действие отменено.",
		"user_stats":          "👤 Логин: <code>%s</code>\n📊 Трафик: <code>%s</code>\n📍 IP: <code>%s</code>",
		"broadcast_prefix":    "📢 <b>Уведомление:</b>\n\n",
	},
	"en": {
		"btn_register":        "📝 Register",
		"btn_stats":           "📊 My Statistics",
		"btn_link":            "🔗 My Link",
		"welcome_user":        "👋 Welcome!\nUse the menu below.",
		"welcome_new":         "👋 Welcome!\nTo get proxy access, please submit a request.",
		"banned":              "🚫 Access denied. Your account is blocked.",
		"req_pending":         "⏳ Your request is under review. Please wait for the administrator's decision.",
		"req_already_pending": "⏳ Your request is already under review.",
		"req_access_denied":   "🚫 Access denied. Account blocked.",
		"req_sent":            "✅ Request submitted!",
		"api_unavailable":     "❌ Server temporarily unavailable.",
		"data_not_found":      "❌ Data not found.",
		"ip_none":             "none",
		"link_error":          "❌ Link generation error.",
		"link_caption":        "🚀 Your connection link:",
		"req_approved":        "🎉 Your request has been approved! The menu is now available.",
		"req_rejected":        "❌ Your request has been rejected.",
		"access_blocked":      "🚫 Your access has been blocked.",
		"proxy_ready":         "🚀 Your proxy is ready!",
		"ban_warning":         "\n\n⚠️ <b>IMPORTANT:</b> This link is personal. Do not share it with others. Violations result in access being blocked.",
		"action_cancelled":    "❌ Action cancelled.",
		"user_stats":          "👤 Login: <code>%s</code>\n📊 Traffic: <code>%s</code>\n📍 IPs: <code>%s</code>",
		"broadcast_prefix":    "📢 <b>Announcement:</b>\n\n",
	},
}

func detectLang(languageCode string) string {
	if strings.HasPrefix(languageCode, "ru") {
		return "ru"
	}
	return "en"
}

func (b *Bot) lang(tgID int64) string {
	l, _ := b.dbGetLang(tgID)
	if l == "" {
		return "ru"
	}
	return l
}

func (b *Bot) t(tgID int64, key string) string {
	l := b.lang(tgID)
	if m, ok := i18nStrings[l]; ok {
		if s, ok := m[key]; ok {
			return s
		}
	}
	if s, ok := i18nStrings["ru"][key]; ok {
		return s
	}
	return key
}

// isButton checks if text matches any language variant of a button key.
func isButton(text, key string) bool {
	for _, m := range i18nStrings {
		if s, ok := m[key]; ok && s == text {
			return true
		}
	}
	return false
}

// isCancel returns true for any cancel text or /cancel command.
func isCancel(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	return lower == "отмена" || lower == "cancel" || text == "/cancel"
}
