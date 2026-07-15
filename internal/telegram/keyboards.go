package telegram

import (
	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func replyKeyboard(rows ...[]tgbotapi.KeyboardButton) tgbotapi.ReplyKeyboardMarkup {
	kb := tgbotapi.NewReplyKeyboard(rows...)
	kb.ResizeKeyboard = true
	return kb
}

func textButton(text string) tgbotapi.KeyboardButton {
	return tgbotapi.NewKeyboardButton(text)
}

func textRow(texts ...string) []tgbotapi.KeyboardButton {
	row := make([]tgbotapi.KeyboardButton, 0, len(texts))
	for _, text := range texts {
		row = append(row, textButton(text))
	}
	return row
}

func inlineDataButton(text, data string) tgbotapi.InlineKeyboardButton {
	return tgbotapi.NewInlineKeyboardButtonData(text, data)
}

func inlineURLButton(text, url string) tgbotapi.InlineKeyboardButton {
	return tgbotapi.NewInlineKeyboardButtonURL(text, url)
}

func inlineRow(buttons ...tgbotapi.InlineKeyboardButton) []tgbotapi.InlineKeyboardButton {
	return tgbotapi.NewInlineKeyboardRow(buttons...)
}

func inlineKeyboard(rows ...[]tgbotapi.InlineKeyboardButton) tgbotapi.InlineKeyboardMarkup {
	return tgbotapi.NewInlineKeyboardMarkup(rows...)
}

func removeKeyboard() tgbotapi.ReplyKeyboardRemove {
	return tgbotapi.NewRemoveKeyboard(true)
}

func (b *Bot) adminKeyboard() tgbotapi.ReplyKeyboardMarkup {
	return replyKeyboard(
		textRow("📊 Статистика", "📥 Заявки"),
		textRow("➕ Добавить", "📢 Рассылка"),
		textRow("⚫️ Черный список", "💾 Бэкап"),
		textRow("⚙️ Сервис"),
	)
}

func (b *Bot) tgIDEntryKeyboard() tgbotapi.ReplyKeyboardMarkup {
	return replyKeyboard(textRow("Отмена"))
}

func (b *Bot) cancelKeyboard() tgbotapi.ReplyKeyboardMarkup {
	return replyKeyboard(textRow("Отмена"))
}

func (b *Bot) userKeyboard(tgID int64) tgbotapi.ReplyKeyboardMarkup {
	return replyKeyboard(textRow(b.t(tgID, "btn_stats"), b.t(tgID, "btn_link")))
}
