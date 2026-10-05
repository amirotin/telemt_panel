package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

func writeHistoryError(w http.ResponseWriter, err error, message string) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || errors.Is(err, store.ErrHistoryTimeout) {
		auth.WriteError(w, http.StatusGatewayTimeout, "history_timeout", "history operation timed out")
		return
	}
	auth.WriteError(w, http.StatusInternalServerError, "internal_error", message)
}
