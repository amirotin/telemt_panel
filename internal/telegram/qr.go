package telegram

import "github.com/skip2/go-qrcode"

func generateQR(data string) ([]byte, error) {
	return qrcode.Encode(data, qrcode.Medium, 512)
}
