package telegram

import (
	"bytes"
	"context"

	tgbot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

func (b *Bot) rawAPI() *tgbot.Bot {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.api
}

func (b *Bot) send(chatID int64, text string) models.Message {
	api := b.rawAPI()
	if api == nil {
		return models.Message{}
	}
	m, _ := api.SendMessage(context.Background(), &tgbot.SendMessageParams{
		ChatID:             chatID,
		Text:               text,
		ParseMode:          models.ParseModeHTML,
		LinkPreviewOptions: &models.LinkPreviewOptions{IsDisabled: tgbot.True()},
	})
	if m == nil {
		return models.Message{}
	}
	return *m
}

func (b *Bot) sendMarkup(chatID int64, text string, markup models.ReplyMarkup) models.Message {
	api := b.rawAPI()
	if api == nil {
		return models.Message{}
	}
	m, _ := api.SendMessage(context.Background(), &tgbot.SendMessageParams{
		ChatID:             chatID,
		Text:               text,
		ParseMode:          models.ParseModeHTML,
		LinkPreviewOptions: &models.LinkPreviewOptions{IsDisabled: tgbot.True()},
		ReplyMarkup:        markup,
	})
	if m == nil {
		return models.Message{}
	}
	return *m
}

func (b *Bot) editText(chatID int64, msgID int, text string, markup *models.InlineKeyboardMarkup) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	api.EditMessageText(context.Background(), &tgbot.EditMessageTextParams{
		ChatID:             chatID,
		MessageID:          msgID,
		Text:               text,
		ParseMode:          models.ParseModeHTML,
		LinkPreviewOptions: &models.LinkPreviewOptions{IsDisabled: tgbot.True()},
		ReplyMarkup:        markup,
	}) //nolint:errcheck
}

func (b *Bot) answerCallback(callbackID, text string) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	api.AnswerCallbackQuery(context.Background(), &tgbot.AnswerCallbackQueryParams{
		CallbackQueryID: callbackID,
		Text:            text,
	}) //nolint:errcheck
}

func (b *Bot) copyMsg(toChatID, fromChatID int64, msgID int) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	api.CopyMessage(context.Background(), &tgbot.CopyMessageParams{
		ChatID:     toChatID,
		FromChatID: fromChatID,
		MessageID:  msgID,
	}) //nolint:errcheck
}

func (b *Bot) forwardMsg(toChatID, fromChatID int64, msgID int) (models.Message, error) {
	api := b.rawAPI()
	if api == nil {
		return models.Message{}, nil
	}
	m, err := api.ForwardMessage(context.Background(), &tgbot.ForwardMessageParams{
		ChatID:     toChatID,
		FromChatID: fromChatID,
		MessageID:  msgID,
	})
	if m == nil {
		return models.Message{}, err
	}
	return *m, err
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
	_, err = api.SendPhoto(context.Background(), &tgbot.SendPhotoParams{
		ChatID:    chatID,
		Photo:     &models.InputFileUpload{Filename: "qr.png", Data: bytes.NewReader(png)},
		Caption:   caption,
		ParseMode: models.ParseModeHTML,
	})
	if err != nil {
		b.send(chatID, caption)
	}
}

func (b *Bot) sendDocument(chatID int64, filename string, data []byte, caption string) {
	api := b.rawAPI()
	if api == nil {
		return
	}
	api.SendDocument(context.Background(), &tgbot.SendDocumentParams{
		ChatID:   chatID,
		Document: &models.InputFileUpload{Filename: filename, Data: bytes.NewReader(data)},
		Caption:  caption,
	}) //nolint:errcheck
}
