package auth

import "context"

// ctxKey namespaces context values set by this package's middleware.
type ctxKey int

const (
	ctxUsername ctxKey = iota
	ctxSessionIDHash
)

// UsernameFromContext returns the authenticated admin's username, as set by
// RequireSession. The bool is false outside a RequireSession-wrapped handler.
func UsernameFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxUsername).(string)
	return v, ok
}

// SessionIDHashFromContext returns the current session's store key, as set
// by RequireSession. The bool is false outside a RequireSession-wrapped
// handler.
func SessionIDHashFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxSessionIDHash).(string)
	return v, ok
}
