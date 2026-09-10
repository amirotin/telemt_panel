package paneltls

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCombinedChallengesIsolatesHostsAndDoesNotRedirect(t *testing.T) {
	handler := func(domain, token string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host == domain && r.URL.Path == "/.well-known/acme-challenge/"+token {
				w.Write([]byte(token))
				return
			}
			http.NotFound(w, r)
		})
	}
	mux := NewChallengeMux(CombineChallenges(handler("admin.example", "admin"), handler("links.example", "links")))
	remove, err := mux.Install("third.example", handler("third.example", "candidate"))
	if err != nil {
		t.Fatal(err)
	}
	defer remove()
	for _, tc := range []struct {
		host, path string
		want       int
	}{
		{"admin.example", "/.well-known/acme-challenge/admin", 200},
		{"links.example", "/.well-known/acme-challenge/links", 200},
		{"third.example", "/.well-known/acme-challenge/candidate", 200},
		{"links.example", "/.well-known/acme-challenge/admin", 404},
		{"unknown.example", "/.well-known/acme-challenge/links", 404},
		{"admin.example", "/", 404},
		{"links.example", "/api/users", 404},
	} {
		r := httptest.NewRequest("GET", "http://"+tc.host+tc.path, nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != tc.want || w.Header().Get("Location") != "" {
			t.Fatalf("%s%s: %d", tc.host, tc.path, w.Code)
		}
	}
}
