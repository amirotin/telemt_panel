package telegram

import (
	"github.com/go-telegram/bot/models"
)

const tgUserRequestID int32 = 1

func replyKeyboard(rows ...[]models.KeyboardButton) models.ReplyKeyboardMarkup {
	return models.ReplyKeyboardMarkup{
		Keyboard:       rows,
		ResizeKeyboard: true,
	}
}

func textButton(text string) models.KeyboardButton {
	return models.KeyboardButton{Text: text}
}

func userRequestButton(text string) models.KeyboardButton {
	return models.KeyboardButton{
		Text: text,
		RequestUsers: &models.KeyboardButtonRequestUsers{
			RequestID:       tgUserRequestID,
			UserIsBot:       false,
			MaxQuantity:     1,
			RequestName:     true,
			RequestUsername: true,
		},
	}
}

func textRow(texts ...string) []models.KeyboardButton {
	row := make([]models.KeyboardButton, 0, len(texts))
	for _, text := range texts {
		row = append(row, textButton(text))
	}
	return row
}

func inlineDataButton(text, data string) models.InlineKeyboardButton {
	return models.InlineKeyboardButton{Text: text, CallbackData: data}
}

func inlineURLButton(text, url string) models.InlineKeyboardButton {
	return models.InlineKeyboardButton{Text: text, URL: url}
}

func inlineRow(buttons ...models.InlineKeyboardButton) []models.InlineKeyboardButton {
	return buttons
}

func inlineKeyboard(rows ...[]models.InlineKeyboardButton) models.InlineKeyboardMarkup {
	return models.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func removeKeyboard() models.ReplyKeyboardRemove {
	return models.ReplyKeyboardRemove{RemoveKeyboard: true}
}

func (b *Bot) adminKeyboard() models.ReplyKeyboardMarkup {
	return replyKeyboard(
		textRow("📊 Статистика", "📥 Заявки"),
		textRow("➕ Добавить", "📢 Рассылка"),
		textRow("⚫️ Черный список", "💾 Бэкап"),
		textRow("⚙️ Сервис"),
	)
}

func (b *Bot) tgIDEntryKeyboard() models.ReplyKeyboardMarkup {
	return replyKeyboard(
		[]models.KeyboardButton{userRequestButton("Выбрать из контактов TG")},
		textRow("Отмена"),
	)
}

func (b *Bot) cancelKeyboard() models.ReplyKeyboardMarkup {
	return replyKeyboard(textRow("Отмена"))
}

func (b *Bot) userKeyboard(tgID int64) models.ReplyKeyboardMarkup {
	return replyKeyboard(textRow(b.t(tgID, "btn_stats"), b.t(tgID, "btn_link")))
}
