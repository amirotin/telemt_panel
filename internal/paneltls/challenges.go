package paneltls

import (
	"net/http"
	"strings"
)

// CombineChallenges serves active HTTP-01 responses for two independent TLS
// endpoints. It never redirects application requests or reveals a secret prefix.
func CombineChallenges(first, second http.Handler) http.Handler {
	if first == nil && second == nil {
		return nil
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/.well-known/acme-challenge/") {
			http.NotFound(w, r)
			return
		}
		for _, handler := range []http.Handler{first, second} {
			if handler == nil {
				continue
			}
			response := &challengeResponse{header: make(http.Header)}
			handler.ServeHTTP(response, r)
			if response.status == http.StatusOK {
				for name, values := range response.header {
					w.Header()[name] = values
				}
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(response.body.Bytes())
				return
			}
		}
		http.NotFound(w, r)
	})
}
