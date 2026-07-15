package telegram

import (
	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func (b *Bot) rawAPI() *tgbotapi.BotAPI {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.api
}

func (b *Bot) send(chatID int64, text string) tgbotapi.Message {
	api := b.rawAPI()
	if api == nil {
		return tgbotapi.Message{}
	}
	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = tgbotapi.ModeHTML
	msg.DisableWebPagePreview = true
	m, _ := api.Send(msg)
	return m
}

func (b *Bot) sendMarkup(chatID int64, text string, markup interface{}) tgbotapi.Message {
	api := b.rawAPI()
	if api == nil {
		return tgbotapi.Message{}
	}
	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = tgbotapi.ModeHTML
	msg.DisableWebPagePreview = true
	msg.ReplyMarkup = markup
	m, _ := api.Send(msg)
	return m
}

func (b *Bot) editText(chatID int64, msgID int, text string, markup *tgbotapi.InlineKeyboardMarkup) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	edit := tgbotapi.NewEditMessageText(chatID, msgID, text)
	edit.ParseMode = tgbotapi.ModeHTML
	edit.DisableWebPagePreview = true
	if markup != nil {
		edit.ReplyMarkup = markup
	}
	api.Send(edit) //nolint:errcheck
}

func (b *Bot) answerCallback(callbackID, text string) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	api.Request(tgbotapi.NewCallback(callbackID, text)) //nolint:errcheck
}

func (b *Bot) copyMsg(toChatID, fromChatID int64, msgID int) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	cp := tgbotapi.CopyMessageConfig{
		BaseChat:   tgbotapi.BaseChat{ChatID: toChatID},
		FromChatID: fromChatID,
		MessageID:  msgID,
	}
	api.Send(cp) //nolint:errcheck
}

func (b *Bot) forwardMsg(toChatID, fromChatID int64, msgID int) (tgbotapi.Message, error) {
	api := b.rawAPI()
	if api == nil {
		return tgbotapi.Message{}, nil
	}
	return api.Send(tgbotapi.NewForward(toChatID, fromChatID, msgID))
}

func (b *Bot) sendQR(chatID int64, data, caption string) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	png, err := generateQR(data)
	if err != nil {
		b.send(chatID, caption)
		return
	}
	photo := tgbotapi.NewPhoto(chatID, tgbotapi.FileBytes{Name: "qr.png", Bytes: png})
	photo.Caption = caption
	photo.ParseMode = tgbotapi.ModeHTML
	if _, err := api.Send(photo); err != nil {
		b.send(chatID, caption)
	}
}

func (b *Bot) sendDocument(chatID int64, filename string, data []byte, caption string) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	doc := tgbotapi.NewDocument(chatID, tgbotapi.FileBytes{Name: filename, Bytes: data})
	doc.Caption = caption
	api.Send(doc) //nolint:errcheck
}
